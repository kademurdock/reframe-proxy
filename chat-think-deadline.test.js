'use strict';
/* Nov 8 2026: THE CHAT THINK DEADLINE (CHAT_THINK_DEADLINE.md). The booth's
 * think deadline, armed by the gateway for chat turns on MiMo, and the chat
 * rescue lane that answers a cut thought. Everything is off unless switched on.
 * Network stays inside fixtures; nothing here makes a paid call. Timers inside
 * server.js are recorded, not run, so a deadline fires when a test says so. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  rescueChatThought, chatPlanMessage, chatNotesMessage, CHAT_PLAN_MESSAGE,
  CHAT_PLAN_MODEL, CHAT_PLAN_MAX_TOKENS, CHAT_PLAN_WAIT_MS, CHAT_WRITE_WAIT_MS,
} = require('./modelbudget');

const SOURCE = fs.readFileSync(require.resolve('./server.js'), 'utf8');

// The whole server.js in a box (the think-deadline.test.js harness), with its own env.
function server(env = {}) {
  const routes = {}, logs = [], calls = [], queue = [], timers = [], waits = [];
  const app = { use() {}, get(path, fn) { routes[`GET ${path}`] = fn; },
    post(path, fn) { routes[`POST ${path}`] = fn; }, listen() {} };
  const express = () => app;
  express.json = () => () => {};
  const jev = { enabled: () => false, apiKey: () => '', learn: async () => {}, log() {}, stats: () => ({}) };
  const noNetwork = () => assert.fail('Network forbidden in chat-think-deadline tests');
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
    process: { env: { OPENROUTER_KEY: 'offline', PROXY_SHARED_SECRET: 'offline', ...env }, exit: noNetwork },
    console: { log: say, warn: say, error: say },
    Buffer, URL, TextDecoder, AbortController, Date, Intl,
    setTimeout: later, clearTimeout: cancel, setInterval: later, clearInterval: cancel, modelFixture: model };
  vm.createContext(context);
  vm.runInContext(SOURCE, context, { filename: require.resolve('./server.js') });
  vm.runInContext('fetchWithTimeout = modelFixture;', context);
  const post = (body, res) => routes['POST /chat/completions']({ body, headers: {}, path: '/chat/completions' }, res);
  return { post, logs, calls, queue, timers, waits, context };
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
const SHORT_THOUGHT = 'Thinking about the apartment question.';
const LONG_THOUGHT = 'RAWTHOUGHT ' + 'Weighing rent against commute time, and what she said about mornings. '.repeat(12);
const json = (value) => () => ({ ok: true, status: 200,
  headers: { get: (key) => key === 'content-type' ? 'application/json' : null },
  text: async () => JSON.stringify(value), json: async () => value });
const reply = (content, finish_reason = 'stop', extra = {}) => ({ choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason }] });
const vote = (word) => json(reply(word));
const PLAN = reply('Say the shorter commute is worth it if mornings are the hard part; ask what the rent gap is.');
const ANSWER = reply('If mornings are the rough part, the shorter commute probably pays for itself. What is the rent gap?');
const TOOL = reply(null, 'tool_calls', { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"rent prices"}' } }] });
const OFF = { effort: 'none', enabled: false, exclude: false };
const LONG_ASK = 'Can you help me think through whether I should move to a new apartment across town or stay put where I am? Rent is higher but the commute is shorter, and I keep going back and forth on it.';
const chat = (extra = {}) => ({ model: 'xiaomi/mimo-v2.6-pro', stream: true, max_tokens: 2000,
  messages: [{ role: 'system', content: 'You are a friendly helper.' }, { role: 'user', content: LONG_ASK }], ...extra });
const deepChat = (extra = {}) => chat({ reasoning: { enabled: true, effort: 'high' }, ...extra });

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
/* An upstream that answers in words at once. */
function speaks(text) {
  const frames = [frame({ role: 'assistant', content: text }), frame({}, 'stop'), 'data: [DONE]\n\n'].map((f) => Buffer.from(f));
  return () => ({ ok: true, status: 200, headers: { get: (key) => key === 'content-type' ? 'text/event-stream' : null },
    body: { getReader: () => ({ read: async () => frames.length ? { done: false, value: frames.shift() } : { done: true }, cancel: async () => {} }) } });
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function untilWaiting(state) {
  for (let i = 0; i < 80 && !state.release; i++) await tick();
  assert.ok(state.release, 'the read loop is waiting on the model');
}
const deadlineTimer = (s) => s.timers.find((t) => String(t.fn).includes('THINK DEADLINE') && !t.cleared);
const armedLine = (s) => s.logs.find((l) => l.includes('[chat-think]') && l.includes('armed'));
const quiet = async (fn) => {
  const keep = { log: console.log, warn: console.warn };
  const logs = [];
  Object.assign(console, { log: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)) });
  try { return { out: await fn(), logs }; } finally { Object.assign(console, keep); }
};

/* Runs one streaming turn whose model only thinks, and returns once it is waiting. */
async function thinkingTurn(env, body, { votes = [] } = {}) {
  const s = server(env);
  const res = response();
  const up = thinking([frame({ role: 'assistant', reasoning: SHORT_THOUGHT })]);
  s.queue.push(...votes.map(vote), up.fixture);
  const done = s.post(body, res);
  await untilWaiting(up.state);
  return { s, res, up, done };
}
async function finish(t) {
  t.up.state.release({ done: true });
  await quiet(() => t.done); // the rescue of an unfinished thought logs to the real console
}

/* ── inert by default ───────────────────────────────────────────────────── */

test('inert by default: no new env, a thinking MiMo chat turn gets no timer, no chat-think line, and the same upstream body', async () => {
  const t = await thinkingTurn({}, deepChat());
  assert.equal(deadlineTimer(t.s), undefined, 'no deadline timer');
  assert.ok(!t.s.logs.some((l) => l.includes('[chat-think]')));
  const sent = t.s.calls[0];
  assert.equal(sent.reasoning.enabled, true);
  assert.equal(sent.reasoning.effort, 'high');
  await finish(t);

  // KADE_MIMO_QUICK unset still rides a quick vote instant, unarmed.
  const q = server({});
  q.queue.push(vote('quick'), speaks('Stay put if the rent gap is big.'));
  await q.post(chat(), response());
  assert.notEqual(q.calls[1].reasoning?.enabled, true);
  assert.ok(!q.timers.some((x) => String(x.fn).includes('THINK DEADLINE')));
  assert.ok(!q.logs.some((l) => l.includes('[chat-think]')));
});

test('inert unless exactly "1": KADE_CHAT_THINK_DEADLINE=0, =true and empty arm nothing', async () => {
  for (const value of ['0', 'true', '']) {
    const t = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: value }, deepChat());
    assert.equal(deadlineTimer(t.s), undefined, `value ${JSON.stringify(value)}`);
    await finish(t);
  }
});

/* ── arming, per tier ───────────────────────────────────────────────────── */

test('armed: explicit effort (Deep button / character setting) gets 75 s', async () => {
  const t = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, deepChat());
  const timer = deadlineTimer(t.s);
  assert.ok(timer, 'a deadline timer was set');
  assert.ok(timer.ms > 70000 && timer.ms <= 75000, `timer at ${timer.ms}`);
  assert.match(armedLine(t.s), /armed 75000 tier=explicit/);
  await finish(t);
});

test('armed: a deep vote gets 45 s', async () => {
  const t = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, chat(), { votes: ['deep'] });
  assert.match(armedLine(t.s), /armed 45000 tier=deep/);
  assert.equal(t.s.calls[1].reasoning.effort, 'high');
  assert.ok(deadlineTimer(t.s).ms <= 45000);
  await finish(t);
});

test('armed: a quick vote that thinks (KADE_MIMO_QUICK=low) gets 20 s; ms are tunable', async () => {
  const t = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1', KADE_MIMO_QUICK: 'low' }, chat(), { votes: ['quick'] });
  assert.match(armedLine(t.s), /armed 20000 tier=quick/);
  await finish(t);
  const tuned = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1', KADE_MIMO_QUICK: 'low', KADE_CHAT_THINK_DEADLINE_QUICK_MS: '30000' }, chat(), { votes: ['quick'] });
  assert.match(armedLine(tuned.s), /armed 30000 tier=quick/);
  await finish(tuned);
  const clamped = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1', KADE_CHAT_THINK_DEADLINE_EXPLICIT_MS: '10' }, deepChat());
  assert.match(armedLine(clamped.s), /armed 5000 tier=explicit/, 'never under the 5 s floor');
  await finish(clamped);
});

test('armed: an agent step after a tool result gets 15 s', async () => {
  const body = deepChat({ messages: [
    { role: 'system', content: 'You are a friendly helper.' },
    { role: 'user', content: LONG_ASK },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_0', type: 'function', function: { name: 'web_search', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_0', content: 'Rent across town averages $1,450.' },
  ], tools: [{ type: 'function', function: { name: 'web_search', parameters: { type: 'object', properties: {} } } }] });
  const t = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, body);
  assert.match(armedLine(t.s), /armed 15000 tier=toolstep/);
  await finish(t);
});

test('not armed: an instant vote, a non-MiMo model, or a phone call', async () => {
  const i = server({ KADE_CHAT_THINK_DEADLINE: '1' });
  i.queue.push(vote('instant'), speaks('Hard to say without the numbers.'));
  await i.post(chat(), response());
  assert.ok(!i.logs.some((l) => l.includes('[chat-think]')));

  const other = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, deepChat({ model: 'deepseek/deepseek-v4.1-flash' }));
  assert.ok(!other.s.logs.some((l) => l.includes('[chat-think]')));
  assert.equal(deadlineTimer(other.s), undefined);
  await finish(other);

  const phone = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, deepChat({ messages: [
    { role: 'system', content: 'You are a friendly helper.' },
    { role: 'user', content: `${LONG_ASK} [PHONE CALL from a caller]` },
  ] }));
  assert.ok(!phone.s.logs.some((l) => l.includes('[chat-think]')));
  assert.equal(deadlineTimer(phone.s), undefined);
  await finish(phone);
});

test('a caller deadline is respected: the booth value stands, and an unusable one is not replaced', async () => {
  const t = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, deepChat({ kade_think_deadline_ms: 90000 }));
  assert.ok(!t.s.logs.some((l) => l.includes('[chat-think]')), 'the gateway does not arm over a caller');
  assert.ok(deadlineTimer(t.s).ms > 85000, 'the caller\'s 90 s timer');
  await finish(t);
  const bad = await thinkingTurn({ KADE_CHAT_THINK_DEADLINE: '1' }, deepChat({ kade_think_deadline_ms: 1 }));
  assert.equal(deadlineTimer(bad.s), undefined, 'an unusable caller value means no deadline, as today');
  assert.ok(!bad.s.logs.some((l) => l.includes('[chat-think]')));
  await finish(bad);
});

/* ── KADE_MIMO_QUICK=deadline ──────────────────────────────────────────── */

test('KADE_MIMO_QUICK=deadline: a quick vote thinks at effort low and gets the quick limit with the master switch off', async () => {
  const t = await thinkingTurn({ KADE_MIMO_QUICK: 'deadline' }, chat(), { votes: ['quick'] });
  const sent = t.s.calls[1];
  assert.equal(sent.reasoning.enabled, true);
  assert.equal(sent.reasoning.effort, 'low');
  assert.match(armedLine(t.s), /armed 20000 tier=quick/);
  assert.ok(t.s.logs.some((l) => l.includes('KADE_MIMO_QUICK=deadline')));
  await finish(t);

  // A deep vote under the same switch, master off: thinks as before, no limit.
  const d = await thinkingTurn({ KADE_MIMO_QUICK: 'deadline' }, chat(), { votes: ['deep'] });
  assert.ok(!d.s.logs.some((l) => l.includes('[chat-think]')));
  assert.equal(deadlineTimer(d.s), undefined);
  await finish(d);
});

/* Review fix: the switch may only make a quick vote think where a time limit can arm. */
test('KADE_MIMO_QUICK=deadline never thinks unbounded: call turns, non-stream and shim callers ride instant', async () => {
  // A call turn with the Aug 14 router restored (KADE_CALL_INSTANT_DEFAULT=0): quick stays instant.
  const p = server({ KADE_MIMO_QUICK: 'deadline', KADE_CALL_INSTANT_DEFAULT: '0' });
  p.queue.push(vote('quick'), speaks('Stay put if the rent gap is big.'));
  await p.post(chat({ messages: [
    { role: 'system', content: 'You are a friendly helper.' },
    { role: 'user', content: `${LONG_ASK} [PHONE CALL from a caller]` },
  ] }), response());
  assert.equal(p.calls.length, 2, 'the vote and the reply');
  assert.notEqual(p.calls[1].reasoning?.enabled, true, 'the call turn does not think');
  assert.ok(!p.timers.some((x) => String(x.fn).includes('THINK DEADLINE')));
  assert.ok(!p.logs.some((l) => l.includes('[chat-think]')));
  assert.ok(p.logs.some((l) => l.includes('no time limit can arm on this turn')));

  // maybeAutoThink straight: only a caller that says deadlineCapable gets the thinking quick.
  const s = server({ KADE_MIMO_QUICK: 'deadline' });
  const run = vm.runInContext('maybeAutoThink', s.context);
  s.queue.push(vote('quick'));
  const nonStream = await run(chat(), 'x'); // the non-stream route passes no decision
  assert.notEqual(nonStream.reasoning?.enabled, true);
  s.queue.push(vote('quick'));
  const shim = { deadlineCapable: false }; // handleStreaming on a shim or phone turn
  const shimOut = await run(chat(), 'x', shim);
  assert.equal(shim.tier, 'instant');
  assert.equal(shim.quickDeadline, undefined);
  assert.notEqual(shimOut.reasoning?.enabled, true);
  s.queue.push(vote('quick'));
  const web = { deadlineCapable: true };
  const webOut = await run(chat(), 'x', web);
  assert.equal(web.tier, 'quick');
  assert.equal(web.quickDeadline, true);
  assert.equal(webOut.reasoning.effort, 'low');
});

test('maybeAutoThink reports its decision without changing what it returns', async () => {
  const s = server({});
  const run = vm.runInContext('maybeAutoThink', s.context);
  const explicit = {};
  const body = deepChat();
  const out = await run(body, 'x', explicit);
  assert.equal(explicit.tier, 'explicit');
  assert.equal(out, body, 'an explicit choice still returns the same object');
  const off = {};
  await run(chat({ reasoning: { enabled: false, effort: 'none' } }), 'x', off);
  assert.equal(off.tier, 'instant');
  s.queue.push(vote('deep'));
  const deep = {};
  await run(chat(), 'x', deep);
  assert.equal(deep.tier, 'deep');
  s.queue.push(vote('quick'));
  const quick = {};
  const quickOut = await run(chat(), 'x', quick);
  assert.equal(quick.tier, 'instant', 'unset KADE_MIMO_QUICK: quick rides instant, reported as such');
  assert.notEqual(quickOut.reasoning?.enabled, true);
  // Without a decision object it behaves as it always did.
  assert.equal(await run(body, 'x'), body);
});

/* ── the chat rescue, end to end ────────────────────────────────────────── */

async function cutTurn(thought, ...after) {
  const s = server({ KADE_CHAT_THINK_DEADLINE: '1' });
  const res = response();
  const up = thinking([frame({ role: 'assistant', reasoning: thought })]);
  s.queue.push(up.fixture, ...after.map(json));
  const done = s.post(deepChat(), res);
  await untilWaiting(up.state);
  deadlineTimer(s).fn();
  const { logs } = await quiet(() => done); // modelbudget logs to the real console
  s.logs.push(...logs);
  return { s, res, up };
}

test('rescue: a long thought is planned on Flash (no models, 250 tokens, 10 s, zdr) and the writer sees only the plan', async () => {
  const { s, res, up } = await cutTurn(LONG_THOUGHT, PLAN, ANSWER);
  assert.equal(up.state.cancelled, true, 'the thought was cut upstream');
  assert.equal(s.calls.length, 3, 'the thought, the plan, the answer');
  const plan = s.calls[1];
  assert.equal(plan.model, CHAT_PLAN_MODEL);
  assert.equal(plan.model, 'xiaomi/mimo-v2.6-flash');
  assert.equal(Object.hasOwn(plan, 'models'), false, 'no models list, so OpenRouter cannot run the plan on Pro');
  assert.equal(plan.max_tokens, 250);
  assert.equal(plan.stream, false);
  assert.deepEqual(plan.reasoning, OFF);
  assert.deepEqual(plan.provider.order, ['DeepInfra'], 'the Flash host order');
  assert.equal(plan.provider.zdr, true);
  assert.equal(plan.provider.data_collection, 'deny');
  assert.equal(s.waits[1], CHAT_PLAN_WAIT_MS);
  assert.equal(CHAT_PLAN_WAIT_MS, 10000);
  assert.equal(plan.messages.length, 2, 'the plan call reads only the notes');
  assert.match(plan.messages[1].content, /RAWTHOUGHT/);

  const writer = s.calls[2];
  assert.equal(writer.model, 'xiaomi/mimo-v2.6-pro', 'the turn\'s own model');
  assert.deepEqual(writer.reasoning, OFF);
  assert.equal(writer.stream, false);
  assert.equal(s.waits[2], CHAT_WRITE_WAIT_MS);
  assert.equal(CHAT_WRITE_WAIT_MS, 60000);
  assert.equal(writer.provider.zdr, true);
  assert.equal(writer.provider.data_collection, 'deny');
  assert.doesNotMatch(JSON.stringify(writer), /RAWTHOUGHT|Weighing rent/, 'the raw thought never reaches the writer');
  const last = writer.messages[writer.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.equal(last.content, chatPlanMessage(PLAN.choices[0].message.content));
  assert.match(res.raw, /shorter commute probably pays for itself/);
  assert.match(res.raw, /\[DONE\]/);
  assert.ok(s.logs.some((l) => l.includes('rescue path: plan then write')));
  assert.ok(s.logs.some((l) => /\[chat-think\]\[req \w+\] landed \d+ chars via the plan/.test(l)));
  assert.ok(!s.logs.some((l) => l.includes('wordless rescue (buffered)')), 'not the booth lane');
});

test('rescue: a writer that calls a tool has its tool_calls passed through, never an empty turn', async () => {
  const { s, res } = await cutTurn(LONG_THOUGHT, PLAN, TOOL);
  assert.equal(s.calls.length, 3);
  assert.match(res.raw, /"tool_calls":\[\{"index":0,"id":"call_1"/);
  assert.match(res.raw, /"finish_reason":"tool_calls"/);
  assert.match(res.raw, /\[DONE\]/);
  assert.ok(s.logs.some((l) => l.includes('landed 1 tool call(s)')));
  assert.ok(s.logs.some((l) => l.includes('chat-think rescue tool turn sent')));
});

test('rescue: a short thought (a host stall) skips the plan and writes once, plainly', async () => {
  const { s, res } = await cutTurn(SHORT_THOUGHT, ANSWER);
  assert.equal(s.calls.length, 2, 'the thought and one plain write');
  const writer = s.calls[1];
  assert.equal(writer.model, 'xiaomi/mimo-v2.6-pro');
  assert.deepEqual(writer.reasoning, OFF);
  assert.equal(writer.messages.length, s.calls[0].messages.length, 'no plan message');
  assert.doesNotMatch(JSON.stringify(writer), /apartment question\./, 'not the thought either');
  assert.match(res.raw, /shorter commute/);
  assert.ok(s.logs.some((l) => l.includes('rescue path: plain write (a 38-char thought is a host stall')));
});

test('rescue: an empty write from the plan falls back to one plain write', async () => {
  const { s, res } = await cutTurn(LONG_THOUGHT, PLAN, reply(''), ANSWER);
  assert.equal(s.calls.length, 4);
  assert.equal(s.calls[3].messages.length, s.calls[0].messages.length, 'the fallback write has no plan');
  assert.equal(s.calls[2].messages.length, s.calls[0].messages.length + 1, 'the first write carried the plan');
  assert.match(res.raw, /shorter commute/);
  assert.ok(s.logs.some((l) => l.includes('rescue path: plain write (fallback')));
});

/* Review fix: a rescue writer that dies mid-reply (finish=error) must not trip the truncation
 * retry, which would resend the original body with thinking on and no time limit. */
test('rescue: a writer that dies mid-reply is served as cut, never re-asked with thinking on', async () => {
  const { s, res } = await cutTurn(SHORT_THOUGHT, reply('If mornings are the rough part, the shorter', 'error'));
  assert.equal(s.calls.length, 2, 'the thought and one plain write: no truncation retry');
  assert.ok(!s.logs.some((l) => l.includes('stream died mid-generation')));
  assert.match(res.raw, /If mornings are the rough part, the shorter/);
  assert.match(res.raw, /"finish_reason":"length"/);
  assert.doesNotMatch(res.raw, /"finish_reason":"error"/);

  // From the plan: a died write falls back to one plain write, like a capped one.
  const body = { model: 'xiaomi/mimo-v2.6-pro', messages: [{ role: 'user', content: 'hi' }] };
  const sent = [];
  const replies = [PLAN, reply('Half an ans', 'error'), ANSWER];
  const call = async (b) => { sent.push(b); return replies.shift(); };
  const got = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'e', callOpenRouter: call, notes: LONG_THOUGHT }));
  assert.equal(sent.length, 3);
  assert.match(got.out.text, /shorter commute/);
  assert.equal(got.out.finishReason, 'stop');
  assert.ok(got.logs.some((l) => l.includes('the write from the plan died mid-reply')));
});

test('rescueChatThought: plan or writer failures fall back to a plain write; all failing returns null', async () => {
  const body = { model: 'xiaomi/mimo-v2.6-pro', max_tokens: 32000, reasoning: { enabled: true, effort: 'high' },
    provider: { order: ['DeepInfra'], zdr: true, data_collection: 'deny', allow_fallbacks: true },
    models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'], messages: [{ role: 'user', content: 'hi' }] };
  const scripted = (replies) => {
    const sent = [];
    const call = async (b, wait) => { sent.push({ body: b, wait }); const r = replies.shift(); if (r instanceof Error) throw r; return r; };
    return { sent, call };
  };

  const a = scripted([new Error('plan host down'), ANSWER]);
  const gotA = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'a', callOpenRouter: a.call, notes: LONG_THOUGHT }));
  assert.match(gotA.out.text, /shorter commute/);
  assert.equal(a.sent.length, 2);
  assert.equal(a.sent[1].body.messages.length, 1, 'plain: no plan');
  assert.equal(a.sent[1].body.max_tokens, 4000, 'the written answer is capped');
  assert.ok(gotA.logs.some((l) => l.includes('plan failed (plan host down)')));

  const b = scripted([PLAN, new Error('writer stalled'), ANSWER]);
  const gotB = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'b', callOpenRouter: b.call, notes: LONG_THOUGHT }));
  assert.match(gotB.out.text, /shorter commute/);
  assert.equal(b.sent.length, 3);

  const c = scripted([PLAN, new Error('down'), new Error('still down')]);
  const gotC = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'c', callOpenRouter: c.call, notes: LONG_THOUGHT }));
  assert.equal(gotC.out, null, 'nothing landed: the existing path takes over');
  assert.ok(gotC.logs.some((l) => l.includes('nothing landed')));

  // A write from the plan that ran to its cap is replaced by a plain write, and kept if that fails.
  const d = scripted([PLAN, reply('A long capped answer.', 'length'), new Error('down')]);
  const gotD = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'd', callOpenRouter: d.call, notes: LONG_THOUGHT }));
  assert.equal(gotD.out.text, 'A long capped answer.');

  // A plain write may call a tool too.
  const e = scripted([TOOL]);
  const gotE = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'e', callOpenRouter: e.call, notes: SHORT_THOUGHT }));
  assert.equal(gotE.out.finishReason, 'tool_calls');
  assert.equal(gotE.out.toolCalls[0].function.name, 'web_search');

  assert.equal(body.messages.length, 1, 'the turn body is not mutated');
  assert.equal(body.reasoning.effort, 'high');

  // A hang-up before the rescue starts costs nothing.
  const ctl = new AbortController();
  ctl.abort();
  const f = scripted([]);
  assert.equal(await rescueChatThought({ upstreamBody: body, reqId: 'f', callOpenRouter: f.call, notes: LONG_THOUGHT, signal: ctl.signal }), null);
  assert.equal(f.sent.length, 0);
});

test('rescueChatThought: a plan call that never answers is cut at its window', async () => {
  const body = { model: 'xiaomi/mimo-v2.6-pro', messages: [{ role: 'user', content: 'hi' }] };
  let seen;
  const replies = [ANSWER];
  const call = (b, wait, signal) => {
    if (b.model === CHAT_PLAN_MODEL) {
      seen = signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return Promise.resolve(replies.shift());
  };
  const keepTimeout = global.setTimeout;
  global.setTimeout = (fn, ms) => keepTimeout(fn, ms === CHAT_PLAN_WAIT_MS ? 5 : ms);
  try {
    const got = await quiet(() => rescueChatThought({ upstreamBody: body, reqId: 'w', callOpenRouter: call, notes: LONG_THOUGHT }));
    assert.match(got.out.text, /shorter commute/);
    assert.equal(seen.aborted, true, 'the stalled plan call was aborted, not left running');
  } finally {
    global.setTimeout = keepTimeout;
  }
});

test('the chat plan message is short, plain and carries no persona', () => {
  assert.equal(CHAT_PLAN_MESSAGE, 'Notes for your reply: {plan}\n\nAnswer the last message now, in your own voice. Don\'t mention these notes.');
  assert.equal(chatPlanMessage('  Say yes. '), 'Notes for your reply: Say yes.\n\nAnswer the last message now, in your own voice. Don\'t mention these notes.');
  assert.equal(chatPlanMessage('costs $& and $1'), 'Notes for your reply: costs $& and $1\n\nAnswer the last message now, in your own voice. Don\'t mention these notes.');
  assert.equal(chatNotesMessage(''), '');
  const long = chatNotesMessage('A'.repeat(2000) + 'M'.repeat(40000) + 'Z'.repeat(12000));
  assert.ok(long.includes('A'.repeat(2000) + '\n[...]\n' + 'Z'.repeat(12000)));
  assert.ok(!long.includes('M'));
  assert.equal(CHAT_PLAN_MAX_TOKENS, 250);
});

/* ── Nov 10 2026: what the rescue spent rides back with the turn ───────────── */

const usageFrames = (raw) => raw.split('\n\n').filter((p) => p.startsWith('data: ') && !p.includes('[DONE]'))
  .map((p) => JSON.parse(p.slice(6))).filter((f) => f.usage).map((f) => f.usage);
const withUsage = (value, usage) => ({ ...value, usage });

test('rescue usage: the plan and writer calls are handed back as the turn usage and logged', async () => {
  const { s, res } = await cutTurn(LONG_THOUGHT,
    withUsage(PLAN, { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, cost: 0.0001 }),
    withUsage(ANSWER, { prompt_tokens: 23000, completion_tokens: 60, total_tokens: 23060, cost: 0.0092 }));
  const usages = usageFrames(res.raw);
  assert.equal(usages.length, 1, 'one terminal usage frame');
  assert.equal(usages[0].prompt_tokens, 23300);
  assert.equal(usages[0].completion_tokens, 100);
  assert.ok(Math.abs(usages[0].cost - 0.0093) < 1e-9, `cost summed, got ${usages[0].cost}`);
  assert.ok(s.logs.some((l) => /rescue usage \(2 call\(s\)\): prompt=23300 completion=100 cost=\$0\.009300/.test(l)), s.logs.filter((l) => l.includes('usage')).join('\n'));
});

test('rescue usage: a rescue tool turn carries the usage too, and nothing is made up when no call reports any', async () => {
  const tool = await cutTurn(LONG_THOUGHT,
    withUsage(PLAN, { prompt_tokens: 300, completion_tokens: 40, total_tokens: 340, cost: 0.0001 }),
    withUsage(TOOL, { prompt_tokens: 23000, completion_tokens: 20, total_tokens: 23020, cost: 0.0091 }));
  assert.match(tool.res.raw, /web_search/);
  assert.equal(usageFrames(tool.res.raw)[0].prompt_tokens, 23300);
  const bare = await cutTurn(LONG_THOUGHT, PLAN, ANSWER);
  assert.deepEqual(usageFrames(bare.res.raw), [], 'no usage reported, none invented');
  assert.ok(!bare.s.logs.some((l) => l.includes('rescue usage')));
});
