'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const BASE = { id: 'offline-sol-usage', object: 'chat.completion.chunk',
  model: 'openai/gpt-6.1-sol', created: 1, provider: 'Azure' };
const USAGE = { prompt_tokens: 18190, completion_tokens: 36, total_tokens: 18226,
  prompt_tokens_details: { cached_tokens: 17000 },
  completion_tokens_details: { reasoning_tokens: 6 }, cost: 0.002742,
  cost_details: { upstream_inference_cost: 0.002742 } };
const event = (value) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (delta, finish_reason = null, extra = {}) =>
  event({ ...BASE, choices: [{ index: 0, delta, finish_reason }], ...extra });
const DONE = 'data: [DONE]\n\n';
const OPEN = chunk({ role: 'assistant' });
const TEXT = chunk({ content: 'Hello.' });
const FINISH = chunk({}, 'stop');
const USAGE_EVENT = event({ ...BASE, choices: [], usage: USAGE });

// Run the shipped endpoint and response path without starting a listener.
// Both HTTP implementations are blocked; the model transport is a fixture.
function harness() {
  const routes = {}, logs = [], calls = [];
  let fixture, forbiddenNetworkCalls = 0;
  const app = { use() {}, get(path, fn) { routes[`GET ${path}`] = fn; },
    post(path, fn) { routes[`POST ${path}`] = fn; }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const jev = { enabled: () => false, apiKey: () => '', learn: async () => {}, log() {}, stats: () => ({}) };
  const noNetwork = () => { forbiddenNetworkCalls++; assert.fail('Network forbidden in stream usage tests'); };
  const model = async (url, options) => {
    calls.push(JSON.parse(options.body));
    if (fixture.json) return { ok: true, status: 200,
      headers: { get: (key) => key === 'content-type' ? 'application/json' : null },
      text: async () => JSON.stringify(fixture.json) };
    const bytes = Buffer.from(fixture.sse);
    let offset = 0;
    return { ok: true, status: 200,
      headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
      body: { getReader: () => ({ read: async () => offset >= bytes.length ? { done: true } :
        { done: false, value: bytes.subarray(offset, offset = Math.min(bytes.length, offset + fixture.split)) } }) } };
  };
  const context = { require: (name) => name === 'express' ? express : name === './jev' ? jev :
    ['http', 'https', 'node:http', 'node:https'].includes(name) ? { request: noNetwork } : require(name),
    process: { env: { OPENROUTER_KEY: 'offline', PROXY_SHARED_SECRET: 'offline' }, exit: noNetwork },
    console: { log: (...parts) => logs.push(parts.join(' ')), warn() {}, error() {} },
    Buffer, URL, TextDecoder, AbortController, Date, Intl,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: noNetwork, modelFixture: model };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: require.resolve('./server.js') });
  // Covers native longPost as well as fetch: no request can escape the fixture.
  vm.runInContext('fetchWithTimeout = modelFixture;', context);
  return async (input) => {
    fixture = input;
    let raw = '';
    const callStart = calls.length;
    const res = { headersSent: false, writableEnded: false,
      set() { return this; }, status() { return this; }, flushHeaders() { this.headersSent = true; },
      write(value) { raw += value; }, send(value) { raw += value; this.writableEnded = true; },
      end() { this.writableEnded = true; }, json() { assert.fail('Unexpected JSON response'); } };
    await routes['POST /chat/completions']({ body: { model: BASE.model, stream: true,
      reasoning: { effort: 'low' }, messages: [
        { role: 'system', content: 'Answer one short fictional greeting.' },
        { role: 'user', content: 'Hello.' } ] }, headers: {}, path: '/chat/completions' }, res);
    assert.equal(forbiddenNetworkCalls, 0);
    assert.equal(calls.length - callStart, 1, 'No model retry or paid cleanup');
    assert.equal(calls[callStart].stream_options.include_usage, true);
    const frames = raw.split('\n\n').filter((part) => part.startsWith('data:'))
      .map((part) => part.slice(5).trim()).map((part) => part === '[DONE]' ? '[DONE]' : JSON.parse(part));
    return { raw, frames, logs };
  };
}

function checkUsage(frames) {
  assert.equal(frames.length, 4);
  assert.equal(frames[0].choices[0].delta.content, 'Hello.');
  assert.equal(frames[1].choices[0].finish_reason, 'stop');
  assert.deepEqual(frames[2].choices, []);
  assert.deepEqual(frames[2].usage, USAGE, 'Actual cache, reasoning and cost fields survive unchanged');
  assert.equal(frames[3], '[DONE]');
  assert.equal(frames.filter((frame) => frame.usage).length, 1);
}

test('Sol buffered content keeps upstream usage after finish and before DONE across network boundaries', async () => {
  const run = harness();
  for (const split of [7, 65536]) {
    const { frames, logs } = await run({ split, sse: OPEN + TEXT + FINISH + USAGE_EVENT + DONE });
    assert.ok(logs.some((line) => line.includes('upstream usage: prompt=18190')));
    checkUsage(frames);
  }
});

test('Sol usage attached to an upstream finish chunk is emitted exactly once', async () => {
  const { frames } = await harness()({ split: 31, sse: OPEN + TEXT + chunk({}, 'stop', { usage: USAGE }) + DONE });
  checkUsage(frames);
});

test('JSON upstream fallback preserves usage when converted to synthetic SSE', async () => {
  const { frames } = await harness()({ json: { ...BASE, object: 'chat.completion',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }], usage: USAGE } });
  checkUsage(frames);
});

test('Missing upstream usage does not produce estimated or fabricated usage', async () => {
  const { frames } = await harness()({ split: 31, sse: OPEN + TEXT + FINISH + DONE });
  assert.equal(frames.length, 3);
  assert.equal(frames.filter((frame) => frame.usage).length, 0);
  assert.equal(frames[2], '[DONE]');
});

test('Sol raw tool passthrough remains byte-for-byte unchanged, including usage', async () => {
  const sse = OPEN + chunk({ tool_calls: [{ index: 0, id: 'offline-call', type: 'function',
    function: { name: 'add_fixture', arguments: '{"a":5,"b":7}' } }] }) +
    chunk({}, 'tool_calls') + USAGE_EVENT + DONE;
  const { raw, frames } = await harness()({ split: 31, sse });
  assert.equal(raw, sse);
  assert.deepEqual(frames.find((frame) => frame.usage).usage, USAGE);
});
