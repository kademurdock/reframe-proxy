'use strict';
/* Oct 16 2026: when LibreChat hangs up, the upstream call is cancelled instead of
 * generating (and billing) for nobody, and a MiMo turn that thinks and then stops
 * with no words gets the wordless rescue on both routes. Network stays on
 * 127.0.0.1 or inside fixtures; nothing here makes a paid call. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} not within ${ms}ms`)), ms)),
]);

// The real longPost / fetchWithTimeout / clientHangupSignal, cut out of server.js.
function transport(env = {}) {
  const start = SOURCE.indexOf('const LONG_FETCH_MS = 290_000;');
  const end = SOURCE.indexOf('// -- friendly out-of-credits error');
  assert.ok(start > 0 && end > start, 'transport block present');
  const logs = [];
  const context = vm.createContext({
    require, URL, Buffer, fetch, AbortController, setTimeout, clearTimeout,
    process: { env }, console: { log() {}, warn: (s) => logs.push(String(s)), error() {} },
  });
  vm.runInContext(`${SOURCE.slice(start, end)}
this.fetchWithTimeout = fetchWithTimeout; this.clientHangupSignal = clientHangupSignal;`, context);
  context.logs = logs;
  return context;
}

// A model host that never finishes: it streams thoughts forever, or (headers:false)
// sits on the request the way a non-stream reasoning call does.
async function endlessUpstream({ headers = true } = {}) {
  let markClosed;
  const closed = new Promise((resolve) => { markClosed = resolve; });
  const server = http.createServer((req, res) => {
    req.resume();
    res.on('close', markClosed);
    if (!headers) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const timer = setInterval(() => res.write('data: {"choices":[{"delta":{"reasoning":"hmm "}}]}\n\n'), 20);
    res.on('close', () => clearInterval(timer));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/chat/completions`,
    closed,
    stop: () => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); },
  };
}

test('a hang-up cancels a streaming upstream read after its headers arrived', async () => {
  const t = transport();
  const up = await endlessUpstream();
  try {
    const client = new AbortController();
    const r = await t.fetchWithTimeout(up.url, { method: 'POST', body: '{}', signal: client.signal }, 90_000);
    const reader = r.body.getReader();
    assert.equal((await reader.read()).done, false);
    client.abort();
    let ended = 'still reading';
    try {
      for (let i = 0; i < 200; i++) {
        const { done } = await reader.read();
        if (done) { ended = 'done'; break; }
      }
    } catch (e) {
      ended = e.name;
    }
    assert.ok(['AbortError', 'done'].includes(ended), ended);
    await within(up.closed, 2000, 'upstream connection closed');
  } finally {
    await up.stop();
  }
});

test('a hang-up cancels a long buffered call still waiting for headers, and a gone caller never connects', async () => {
  const t = transport();
  const up = await endlessUpstream({ headers: false });
  try {
    const client = new AbortController();
    const pending = t.fetchWithTimeout(up.url, { method: 'POST', body: '{}', signal: client.signal }, 600_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    client.abort();
    await assert.rejects(within(pending, 2000, 'long call rejected'), { name: 'AbortError' });
    await within(up.closed, 2000, 'upstream connection closed');
    await assert.rejects(t.fetchWithTimeout(up.url, { method: 'POST', body: '{}', signal: client.signal }, 600_000), { name: 'AbortError' });
    await assert.rejects(t.fetchWithTimeout(up.url, { method: 'POST', body: '{}', signal: client.signal }, 90_000), { name: 'AbortError' });
  } finally {
    await up.stop();
  }
});

test('the hang-up signal fires only when the response closes unfinished', () => {
  const t = transport();
  const finished = Object.assign(new EventEmitter(), { writableFinished: true });
  const done = t.clientHangupSignal(finished, 'aaaaaa');
  finished.emit('close');
  assert.equal(done.aborted, false, 'a normal finish also emits close');
  const gone = Object.assign(new EventEmitter(), { writableFinished: false });
  const left = t.clientHangupSignal(gone, 'bbbbbb');
  gone.emit('close');
  assert.equal(left.aborted, true);
  assert.ok(t.logs.some((line) => line.includes('[req bbbbbb] client hung up')));
  assert.equal(t.clientHangupSignal({}, 'cccccc').aborted, false, 'offline harness responses have no events');
  const off = transport({ KADE_CLIENT_ABORT: '0' });
  const res = Object.assign(new EventEmitter(), { writableFinished: false });
  const ignored = off.clientHangupSignal(res, 'dddddd');
  res.emit('close');
  assert.equal(ignored.aborted, false, 'kill switch');
});

// The real callOpenRouter retry ladder over a stub transport.
function retryLadder(fetchStub) {
  const start = SOURCE.indexOf('async function callOpenRouterOnce(');
  const end = SOURCE.indexOf('// -- rewrite guidance');
  assert.ok(start > 0 && end > start, 'retry ladder present');
  const same = (b) => b;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} }, setTimeout, JSON, Number, Error, Set, Promise, String,
    adaptForMimo: same, adaptForSol: same, adaptForDeepseek: same, adaptForXai: same, adaptForZai: same, adaptForGlm: same, adaptForKimi: same,
    chatCompletionsUrl: () => 'https://model.test/chat/completions', chatHeaders: () => ({}),
    isZaiDirectModel: () => false, shouldFallbackToOpenRouter: () => false, shouldFallbackZaiToOpenRouter: () => false,
    REQUEST_TIMEOUT_MS: 90_000, DEEP_TIMEOUT_MS: 600_000, fetchWithTimeout: fetchStub,
  });
  vm.runInContext(`${SOURCE.slice(start, end)}\nthis.callOpenRouter = callOpenRouter;`, context);
  return context;
}
const abortError = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });

test('a hang-up is never retried as a timeout, while a real timeout still gets its one retry', async () => {
  let calls = 0;
  const hung = retryLadder((_url, options) => {
    calls++;
    return new Promise((_, reject) => {
      if (options.signal.aborted) reject(abortError());
      else options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    });
  });
  const client = new AbortController();
  const pending = hung.callOpenRouter({ model: 'xiaomi/mimo-v2.6-pro', reasoning: { effort: 'high' } }, undefined, client.signal);
  setTimeout(() => client.abort(), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);

  let timeouts = 0;
  const slow = retryLadder(async () => {
    timeouts++;
    if (timeouts === 1) throw abortError();
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"choices":[]}' };
  });
  assert.deepEqual(await slow.callOpenRouter({ model: 'xiaomi/mimo-v2.6-pro' }), { choices: [] });
  assert.equal(timeouts, 2);
});

/* The whole server.js in a box (the stream-usage.test.js harness): the shipped
 * route and both response paths, with the model transport as a queue of fixtures. */
function server() {
  const routes = {}, logs = [], calls = [], queue = [];
  const app = { use() {}, get(path, fn) { routes[`GET ${path}`] = fn; },
    post(path, fn) { routes[`POST ${path}`] = fn; }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const jev = { enabled: () => false, apiKey: () => '', learn: async () => {}, log() {}, stats: () => ({}) };
  const noNetwork = () => assert.fail('Network forbidden in hang-up tests');
  const model = async (_url, options) => {
    calls.push(JSON.parse(options.body));
    const next = queue.shift();
    assert.ok(next, 'unexpected extra model call');
    return next(options);
  };
  const say = (...parts) => logs.push(parts.join(' '));
  const context = { require: (name) => name === 'express' ? express : name === './jev' ? jev :
    ['http', 'https', 'node:http', 'node:https'].includes(name) ? { request: noNetwork } : require(name),
    process: { env: { OPENROUTER_KEY: 'offline', PROXY_SHARED_SECRET: 'offline' }, exit: noNetwork },
    console: { log: say, warn: say, error: say },
    Buffer, URL, TextDecoder, AbortController, Date, Intl,
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    fetch: noNetwork, modelFixture: model };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: require.resolve('./server.js') });
  vm.runInContext('fetchWithTimeout = modelFixture;', context);
  const post = (body, res) => routes['POST /chat/completions']({ body, headers: {}, path: '/chat/completions' }, res);
  return { post, logs, calls, queue };
}

function response() {
  const res = new EventEmitter();
  const finish = () => {
    if (res.writableEnded) return;
    res.writableEnded = true;
    res.writableFinished = true;
    res.emit('close');
  };
  return Object.assign(res, {
    raw: '', body: null, headersSent: false, writableEnded: false, writableFinished: false,
    set() { return res; }, status() { return res; }, flushHeaders() { res.headersSent = true; },
    write(value) { res.raw += value; return true; },
    send(value) { res.raw += value; finish(); return res; },
    json(value) { res.body = value; finish(); return res; },
    end() { finish(); },
    hangUp() { res.emit('close'); },
  });
}

const BASE = { id: 'offline-mimo', object: 'chat.completion.chunk', model: 'xiaomi/mimo-v2.6-pro', created: 1, provider: 'DeepInfra' };
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...BASE, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const THOUGHT = frame({ role: 'assistant', reasoning: 'They asked for a short line, so I will think it through first and answer plainly.' });
const sse = (text) => () => {
  const bytes = Buffer.from(text);
  let done = false;
  return { ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
    body: { getReader: () => ({ read: async () => done ? { done: true } : (done = true, { done: false, value: bytes }) }) } };
};
const json = (value) => () => ({ ok: true, status: 200,
  headers: { get: (key) => key === 'content-type' ? 'application/json' : null }, text: async () => JSON.stringify(value) });
const RESCUE = { choices: [{ index: 0, message: { role: 'assistant', content: 'Recovered.' }, finish_reason: 'stop' }] };
const turn = (stream) => ({ model: 'xiaomi/mimo-v2.6-pro', stream, reasoning: { effort: 'low' }, messages: [
  { role: 'system', content: 'Answer one short fictional greeting.' }, { role: 'user', content: 'Hello.' }] });
const OFF = { effort: 'none', enabled: false, exclude: false };

test('streaming: a MiMo turn that thinks and stops with no words is rescued, and the finish is no hang-up', async () => {
  const s = server();
  const res = response();
  s.queue.push(sse(THOUGHT + frame({}, 'stop') + 'data: [DONE]\n\n'), json(RESCUE));
  await s.post(turn(true), res);
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[0].provider.zdr, true);
  assert.deepEqual(s.calls[0].provider.order, ['DeepInfra']);
  assert.equal(s.calls[1].stream, false);
  assert.deepEqual(s.calls[1].reasoning, OFF);
  assert.equal(s.calls[1].provider.zdr, true);
  assert.match(res.raw, /Recovered\./);
  assert.ok(s.logs.some((line) => line.includes('WORDLESS TURN CAUGHT (finish=stop')));
  assert.ok(!s.logs.some((line) => line.includes('client hung up')));
});

test('streaming: a hang-up mid-thought cancels the read and runs nothing after it', async () => {
  const s = server();
  const res = response();
  let reader;
  s.queue.push(() => {
    let first = Buffer.from(THOUGHT), release;
    reader = {
      cancelled: false,
      read: async () => {
        if (first) { const value = first; first = null; return { done: false, value }; }
        const waiting = new Promise((resolve) => { release = resolve; });
        Promise.resolve().then(() => res.hangUp());
        return waiting;
      },
      cancel: async () => { reader.cancelled = true; if (release) release({ done: true }); },
    };
    return { ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
      body: { getReader: () => reader } };
  });
  await within(s.post(turn(true), res), 2000, 'abandoned turn returned');
  assert.equal(reader.cancelled, true);
  assert.equal(s.calls.length, 1, 'no rescue, retry or rewrite for nobody');
  assert.ok(s.logs.some((line) => line.includes('client hung up')));
  assert.ok(s.logs.some((line) => line.includes('turn abandoned by the client')));
  assert.doesNotMatch(res.raw, /\[DONE\]/);
});

test('non-stream: a wordless stop is rescued, a tool call is left alone', async () => {
  const s = server();
  const res = response();
  s.queue.push(json({ choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning: 'Long thought.' }, finish_reason: 'stop' }] }), json(RESCUE));
  await s.post(turn(false), res);
  assert.equal(s.calls.length, 2);
  assert.deepEqual(s.calls[1].reasoning, OFF);
  assert.equal(res.body.choices[0].message.content, 'Recovered.');
  assert.ok(s.logs.some((line) => line.includes('WORDLESS TURN CAUGHT on non-stream')));
  assert.ok(!s.logs.some((line) => line.includes('client hung up')));

  const tools = server();
  const toolRes = response();
  const call = { id: 'offline-call', type: 'function', function: { name: 'web_search', arguments: '{}' } };
  tools.queue.push(json({ choices: [{ index: 0, message: { role: 'assistant', content: '', reasoning: 'Look it up.', tool_calls: [call] }, finish_reason: 'stop' }] }));
  await tools.post(turn(false), toolRes);
  assert.equal(tools.calls.length, 1);
  assert.equal(JSON.stringify(toolRes.body.choices[0].message.tool_calls), JSON.stringify([call]));
});

test('non-stream: a hang-up while the model works cancels it without a retry or an error reply', async () => {
  const s = server();
  const res = response();
  s.queue.push((options) => new Promise((_, reject) => {
    options.signal.addEventListener('abort', () => reject(abortError()), { once: true });
    Promise.resolve().then(() => res.hangUp());
  }));
  await within(s.post(turn(false), res), 2000, 'abandoned call returned');
  assert.equal(s.calls.length, 1, 'the timeout guard must not retry a hang-up');
  assert.equal(res.body, null);
  assert.equal(res.raw, '');
});
