'use strict';
/* Oct 27 2026: THE THINK DEADLINE (modelbudget.js). A caller that sends
 * kade_think_deadline_ms gets a thought cut at that mark and the answer asked
 * for with thinking off, carrying the model's own notes. Network stays inside
 * fixtures; nothing here makes a paid call. Timers are recorded, not run, so a
 * deadline fires exactly when a test says so. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { takeThinkDeadline, thinkNotesMessage, thinkPlanMessage, rescueWordlessTurn } = require('./modelbudget');

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');

// The whole server.js in a box (the client-hangup.test.js harness), with timers kept in a list.
function server() {
  const routes = {}, logs = [], calls = [], queue = [], timers = [], waits = [];
  const app = { use() {}, get(path, fn) { routes[`GET ${path}`] = fn; },
    post(path, fn) { routes[`POST ${path}`] = fn; }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const jev = { enabled: () => false, apiKey: () => '', learn: async () => {}, log() {}, stats: () => ({}) };
  const noNetwork = () => assert.fail('Network forbidden in think-deadline tests');
  const model = async (_url, options, timeoutMs) => {
    calls.push(JSON.parse(options.body));
    waits.push(timeoutMs);
    const next = queue.shift();
    assert.ok(next, 'unexpected extra model call');
    return next(options);
  };
  const say = (...parts) => logs.push(parts.join(' '));
  const later = (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; };
  const cancel = (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; };
  const context = { require: (name) => name === 'express' ? express : name === './jev' ? jev :
    ['http', 'https', 'node:http', 'node:https'].includes(name) ? { request: noNetwork } : require(name),
    process: { env: { OPENROUTER_KEY: 'offline', PROXY_SHARED_SECRET: 'offline' }, exit: noNetwork },
    console: { log: say, warn: say, error: say },
    Buffer, URL, TextDecoder, AbortController, Date, Intl,
    setTimeout: later, clearTimeout: cancel, setInterval: later, clearInterval: cancel, modelFixture: model };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: require.resolve('./server.js') });
  vm.runInContext('fetchWithTimeout = modelFixture;', context);
  const post = (body, res) => routes['POST /chat/completions']({ body, headers: {}, path: '/chat/completions' }, res);
  return { post, logs, calls, queue, timers, waits };
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
  });
}

const BASE = { id: 'offline-mimo', object: 'chat.completion.chunk', model: 'xiaomi/mimo-v2.6-pro', created: 1, provider: 'DeepInfra' };
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ ...BASE, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const NOTE = 'The chorus should land on the hook, so the verses build toward it.';
const THOUGHT = frame({ role: 'assistant', reasoning: NOTE });
const json = (value) => () => ({ ok: true, status: 200,
  headers: { get: (key) => key === 'content-type' ? 'application/json' : null }, text: async () => JSON.stringify(value) });
const RESCUE = { choices: [{ index: 0, message: { role: 'assistant', content: 'TITLE: Recovered\nLyrics:\n[Verse 1]\nA line.' }, finish_reason: 'stop' }] };
const OFF = { effort: 'none', enabled: false, exclude: false };
const PLAN = { choices: [{ index: 0, message: { role: 'assistant', content: 'Plan: a dog song, hook in the chorus. Keep: "he steals the light".' }, finish_reason: 'stop' }] };
const RAN_ON = { choices: [{ index: 0, message: { role: 'assistant', content: 'Wait, let me fix that verse. 1: try this. 2: no.' }, finish_reason: 'length' }] };
const song = (extra = {}) => ({ model: 'xiaomi/mimo-v2.6-pro', stream: true, reasoning: { enabled: true, effort: 'medium', exclude: true },
  max_tokens: 16384, messages: [{ role: 'system', content: 'Write the song in the delivery format.' }, { role: 'user', content: 'A song about a dog.' }], ...extra });

/* An upstream that sends the given frames, then waits like a model still thinking until it is cancelled. */
function thinking(frames) {
  const state = { cancelled: false, release: null };
  const fixture = () => {
    const pending = frames.map((f) => Buffer.from(f));
    const reader = {
      read: async () => {
        if (pending.length) return { done: false, value: pending.shift() };
        if (state.cancelled) return { done: true };
        return new Promise((resolve) => { state.release = resolve; });
      },
      cancel: async () => { state.cancelled = true; if (state.release) state.release({ done: true }); },
    };
    return { ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
      body: { getReader: () => reader } };
  };
  return { fixture, state };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function untilWaiting(state) {
  for (let i = 0; i < 50 && !state.release; i++) await tick();
  assert.ok(state.release, 'the read loop is waiting on the model');
}
const deadlineTimer = (s) => s.timers.find((t) => String(t.fn).includes('THINK DEADLINE') && !t.cleared);

test('takeThinkDeadline: the field always leaves the body; only a sane number arms it', () => {
  const body = { model: 'm', kade_think_deadline_ms: 210000, messages: [] };
  const taken = takeThinkDeadline(body);
  assert.equal(taken.deadlineMs, 210000);
  assert.equal(Object.hasOwn(taken.body, 'kade_think_deadline_ms'), false);
  assert.equal(Object.hasOwn(body, 'kade_think_deadline_ms'), true, 'the caller object is not mutated');
  assert.equal(takeThinkDeadline({ model: 'm' }).deadlineMs, null);
  for (const bad of [0, 4999, 1800001, 'soon', null, NaN, -1]) {
    const t = takeThinkDeadline({ kade_think_deadline_ms: bad });
    assert.equal(t.deadlineMs, null, String(bad));
    assert.equal(Object.hasOwn(t.body, 'kade_think_deadline_ms'), false);
  }
  const before = process.env.KADE_THINK_DEADLINE;
  process.env.KADE_THINK_DEADLINE = '0';
  try {
    const off = takeThinkDeadline({ kade_think_deadline_ms: 90000 });
    assert.equal(off.deadlineMs, null);
    assert.equal(Object.hasOwn(off.body, 'kade_think_deadline_ms'), false);
  } finally {
    if (before === undefined) delete process.env.KADE_THINK_DEADLINE; else process.env.KADE_THINK_DEADLINE = before;
  }
});

test('thinkNotesMessage: empty notes add nothing; a long thought keeps its opening and its latest stretch', () => {
  assert.equal(thinkNotesMessage(''), '');
  assert.equal(thinkNotesMessage('   '), '');
  const short = thinkNotesMessage(NOTE);
  assert.match(short, /<notes>\nThe chorus should land/);
  assert.match(short, /Write a short plan from them/);
  assert.match(thinkPlanMessage('Plan here.'), /<plan>\nPlan here\.\n<\/plan>[\s\S]*Show no working/);
  const long = 'A'.repeat(4000) + 'M'.repeat(50000) + 'Z'.repeat(28000);
  const capped = thinkNotesMessage(long);
  assert.ok(capped.includes('A'.repeat(4000) + '\n[...]\n' + 'Z'.repeat(28000)));
  assert.ok(!capped.includes('M'));
  assert.ok(capped.length < 33000);
});

test('rescueWordlessTurn: notes become a short plan, the answer is written from the plan with thinking off and a cap', async () => {
  const sent = [];
  const replies = [PLAN, RESCUE, RESCUE];
  const callOpenRouter = async (body, wait) => { sent.push({ body, wait }); return replies.shift(); };
  const upstreamBody = song();
  const keep = { log: console.log, warn: console.warn };
  Object.assign(console, { log() {}, warn() {} });
  try {
    const got = await rescueWordlessTurn({ upstreamBody, reqId: 't1', callOpenRouter, notes: NOTE, callTimeoutMs: 150000 });
    assert.match(got.text, /Recovered/);
    const without = await rescueWordlessTurn({ upstreamBody, reqId: 't2', callOpenRouter });
    assert.match(without.text, /Recovered/);
  } finally {
    Object.assign(console, keep);
  }
  const [plan, write, plain] = sent;
  assert.equal(plan.body.max_tokens, 700);
  assert.equal(plan.wait, 40000);
  assert.deepEqual(plan.body.reasoning, OFF);
  assert.equal(plan.body.messages.length, 2, 'the plan call reads only the notes, not the 42k-char prompt');
  assert.match(plan.body.messages[1].content, /<notes>\nThe chorus should land/);
  assert.equal(write.body.messages.length, 3);
  assert.match(write.body.messages[2].content, /<plan>\nPlan: a dog song/);
  assert.doesNotMatch(JSON.stringify(write.body.messages), /<notes>/, 'raw notes never reach the writer');
  assert.equal(write.body.max_tokens, 4000, 'the answer is capped');
  assert.equal(write.wait, 150000);
  assert.deepEqual(write.body.reasoning, OFF);
  assert.equal(write.body.stream, false);
  assert.equal(plain.body.messages.length, 2, 'no notes, no extra message: the old rescue exactly');
  assert.equal(plain.body.max_tokens, 16384, 'and no cap');
  assert.equal(upstreamBody.messages.length, 2, 'the turn body is not mutated');
});

test('rescueWordlessTurn: an answer that runs to its cap is written again with no plan; a failed plan writes with none', async () => {
  const keep = { log: console.log, warn: console.warn };
  const logs = [];
  Object.assign(console, { log: (m) => logs.push(m), warn: (m) => logs.push(m) });
  try {
    const sent = [];
    const replies = [PLAN, RAN_ON, RESCUE];
    const call = async (body) => { sent.push(body); return replies.shift(); };
    const got = await rescueWordlessTurn({ upstreamBody: song(), reqId: 'r1', callOpenRouter: call, notes: NOTE });
    assert.match(got.text, /Recovered/);
    assert.equal(sent.length, 3);
    assert.ok(!sent[2].messages.some((m) => /<plan>|<notes>/.test(String(m.content))), 'the second write has no plan');
    assert.equal(sent[2].max_tokens, 4000);
    assert.ok(logs.some((m) => /ran to its 4000-token cap -- writing again with no plan/.test(m)));

    const sent2 = [];
    const replies2 = [new Error('plan host down'), RESCUE];
    const call2 = async (body) => { sent2.push(body); const r = replies2.shift(); if (r instanceof Error) throw r; return r; };
    const got2 = await rescueWordlessTurn({ upstreamBody: song(), reqId: 'r2', callOpenRouter: call2, notes: NOTE });
    assert.match(got2.text, /Recovered/);
    assert.equal(sent2.length, 2);
    assert.ok(!sent2[1].messages.some((m) => /<plan>|<notes>/.test(String(m.content))));
    assert.ok(logs.some((m) => /plan failed: plan host down -- writing with no plan/.test(m)));
  } finally {
    Object.assign(console, keep);
  }
});

test('streaming: at the deadline a turn with only thoughts is cut and answered from its notes', async () => {
  const s = server();
  const res = response();
  const up = thinking([THOUGHT]);
  s.queue.push(up.fixture, json(PLAN), json(RESCUE));
  const done = s.post(song({ kade_think_deadline_ms: 210000 }), res);
  await untilWaiting(up.state);
  assert.equal(Object.hasOwn(s.calls[0], 'kade_think_deadline_ms'), false, 'the provider never sees the field');
  const timer = deadlineTimer(s);
  assert.ok(timer, 'a deadline timer was set');
  assert.ok(timer.ms > 200000 && timer.ms <= 210000, `timer at ${timer.ms}ms`);
  timer.fn();
  await done;
  assert.equal(up.state.cancelled, true, 'the thought was cut upstream');
  assert.equal(s.calls.length, 3, 'the thought, the plan, the answer');
  assert.match(s.calls[1].messages[1].content, /<notes>[\s\S]*The chorus should land on the hook/);
  assert.equal(s.waits[1], 40000);
  const rescue = s.calls[2];
  assert.equal(rescue.stream, false);
  assert.deepEqual(rescue.reasoning, OFF);
  assert.equal(rescue.max_tokens, 4000);
  assert.equal(Object.hasOwn(rescue, 'kade_think_deadline_ms'), false);
  assert.equal(s.waits[2], 150000, 'the whole song gets 150 s a try (two fit the 5 minutes the booth keeps), not 90 s');
  const last = rescue.messages[rescue.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /<plan>\nPlan: a dog song/);
  assert.match(res.raw, /Recovered/);
  assert.match(res.raw, /\[DONE\]/);
  assert.ok(s.logs.some((line) => line.includes('THINK DEADLINE: 210000ms')));
  assert.ok(s.logs.some((line) => line.includes('WORDLESS TURN CAUGHT (finish=length')));
  assert.ok(!s.logs.some((line) => line.includes('stream died mid-generation')), 'no truncation retry thinks it all again');
});

test('streaming: words before the deadline mean the deadline does nothing', async () => {
  const s = server();
  const res = response();
  const up = thinking([THOUGHT, frame({ role: 'assistant', content: 'TITLE: Mine\nLyrics:\n[Verse 1]\nOwn words.' })]);
  s.queue.push(up.fixture);
  const done = s.post(song({ kade_think_deadline_ms: 90000 }), res);
  await untilWaiting(up.state);
  const timer = deadlineTimer(s);
  assert.ok(timer, 'a deadline timer was set');
  timer.fn();
  assert.equal(up.state.cancelled, false, 'a turn already writing is never cut');
  up.state.release({ done: true });
  await done;
  assert.equal(s.calls.length, 1, 'no rescue');
  assert.match(res.raw, /Own words\./);
  assert.ok(!s.logs.some((line) => line.includes('THINK DEADLINE')));
});

test('streaming: with a deadline set, a token-budget stop also hands over the notes', async () => {
  const s = server();
  const res = response();
  const frames = [THOUGHT, frame({}, 'length'), 'data: [DONE]\n\n'];
  const pending = frames.map((f) => Buffer.from(f));
  s.queue.push(() => ({ ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
    body: { getReader: () => ({ read: async () => pending.length ? { done: false, value: pending.shift() } : { done: true }, cancel: async () => {} }) } }), json(PLAN), json(RESCUE));
  await s.post(song({ kade_think_deadline_ms: 300000 }), res);
  assert.equal(s.calls.length, 3);
  assert.match(s.calls[1].messages[1].content, /<notes>[\s\S]*The chorus should land/);
  const last = s.calls[2].messages[s.calls[2].messages.length - 1];
  assert.match(last.content, /<plan>/);
  assert.match(res.raw, /Recovered/);
  assert.ok(!s.logs.some((line) => line.includes('THINK DEADLINE')), 'the model stopped by itself');
});

test('streaming: without a deadline, a token-budget stop is rescued with no notes', async () => {
  const s = server();
  const res = response();
  const frames = [THOUGHT, frame({}, 'length'), 'data: [DONE]\n\n'];
  const pending = frames.map((f) => Buffer.from(f));
  s.queue.push(() => ({ ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
    body: { getReader: () => ({ read: async () => pending.length ? { done: false, value: pending.shift() } : { done: true }, cancel: async () => {} }) } }), json(RESCUE));
  await s.post(song(), res);
  assert.ok(!s.timers.some((t) => String(t.fn).includes('THINK DEADLINE')), 'no deadline timer without the field');
  assert.equal(s.calls.length, 2);
  assert.equal(s.calls[1].messages.length, s.calls[0].messages.length, 'the old rescue exactly: no notes message');
  assert.ok(!s.calls[1].messages.some((m) => /<notes>/.test(String(m.content))));
  assert.equal(s.waits[1], 90000, 'an ordinary rescue keeps its usual wait');
  assert.match(res.raw, /Recovered/);
});

test('non-stream: the field is taken off and never reaches the provider', async () => {
  const s = server();
  const res = response();
  s.queue.push(json(RESCUE));
  await s.post(song({ stream: false, kade_think_deadline_ms: 120000 }), res);
  assert.equal(Object.hasOwn(s.calls[0], 'kade_think_deadline_ms'), false);
});

test('kill switch: KADE_THINK_DEADLINE=0 sets no timer and cuts nothing', async (t) => {
  const before = process.env.KADE_THINK_DEADLINE;
  process.env.KADE_THINK_DEADLINE = '0';
  t.after(() => { if (before === undefined) delete process.env.KADE_THINK_DEADLINE; else process.env.KADE_THINK_DEADLINE = before; });
  const s = server();
  const res = response();
  const frames = [THOUGHT, frame({ role: 'assistant', content: 'TITLE: Mine\nLyrics:\nOwn.' }, 'stop'), 'data: [DONE]\n\n'];
  const pending = frames.map((f) => Buffer.from(f));
  s.queue.push(() => ({ ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
    body: { getReader: () => ({ read: async () => pending.length ? { done: false, value: pending.shift() } : { done: true }, cancel: async () => {} }) } }));
  await s.post(song({ kade_think_deadline_ms: 90000 }), res);
  assert.equal(Object.hasOwn(s.calls[0], 'kade_think_deadline_ms'), false);
  assert.ok(!s.timers.some((x) => String(x.fn).includes('THINK DEADLINE')), 'no deadline timer');
  assert.match(res.raw, /Own\./);
});

test('streaming: a thought cut before the bubble showed a sentence never lands in the song as a <think> block', async () => {
  const s = server();
  const res = response();
  const unfinished = frame({ role: 'assistant', reasoning: 'weighing the hook against the second verse without a full stop yet' });
  const up = thinking([unfinished]);
  s.queue.push(up.fixture, json(PLAN), json(RESCUE));
  const done = s.post(song({ kade_think_deadline_ms: 90000 }), res);
  await untilWaiting(up.state);
  deadlineTimer(s).fn();
  await done;
  assert.match(res.raw, /Recovered/);
  assert.doesNotMatch(res.raw, /<think>/);
  assert.ok(s.logs.some((line) => line.includes('think deadline lane')));
});

test('thinkNotesMessage never splits an emoji at either cut', () => {
  const emoji = '\u{1F3B8}';
  for (const shift of [0, 1]) {
    const long = 'a'.repeat(3999 + shift) + emoji + 'b'.repeat(60000) + emoji + 'c'.repeat(27999 + shift);
    const out = thinkNotesMessage(long);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out), `shift ${shift}: no lone half of a pair`);
  }
});
