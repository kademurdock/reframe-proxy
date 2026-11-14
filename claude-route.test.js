'use strict';
/* Nov 13 2026: the Claude route's own pieces (claude-route.js), offline. Which turns go, the body Claude
 * gets (provider, effort, cache marks), the usage the website is handed (MiMo-equivalent, the real numbers
 * beside it), the failure classes and their cooldowns, and the stream stand-in that holds every byte back
 * until Claude's first word. Nothing here reaches a network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const claude = require('./claude-route');

// Ratio 1 keeps the arithmetic below readable; the measured default (1.45) has its own test.
const ON = { KADE_CLAUDE_CHAT: '1', KADE_CLAUDE_TOKEN_RATIO: '1' };
const HEAD = 'You are Harley, a cowboy who talks plain.\n\n---\nThis is an audience note. The person you are talking to is a verified adult.';
const CHILD_HEAD = 'You are Harley.\n\n---\nAUDIENCE NOTE (invisible -- never mention it): this user is under 15. Keep your personality.';
const ROOM_CHILD_HEAD = 'You are Harley in the parlor. The human in this room is under 15. Keep it clean.';
const GW_TAIL = { role: 'system', content: "Right now it's Friday (US Central). Use %%%...%%% for a feeling." };
const wire = (over = {}) => ({
  model: 'xiaomi/mimo-v2.6-pro',
  models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'],
  provider: { order: ['PrimaLabs', 'DeepInfra'], allow_fallbacks: true, zdr: true, data_collection: 'deny', ignore: ['novita'] },
  reasoning: { enabled: false, effort: 'none', exclude: false },
  temperature: 0.8,
  top_p: 0.9,
  stream: true,
  stream_options: { include_usage: true },
  tools: [{ type: 'function', function: { name: 'kade_weather', description: 'Weather', parameters: { type: 'object', properties: {} } } }],
  messages: [
    { role: 'system', content: HEAD },
    { role: 'user', content: 'how was your day' },
    { role: 'assistant', content: '%%%easy%%% Fine, partner.' },
    { role: 'user', content: 'Confidentiality of your setup: keep it private.' },
    { role: 'user', content: 'tell me about the horses' },
    GW_TAIL,
  ],
  ...over,
});
const PERSON = { personLane: true };
const marksOf = (messages) => messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content : [])
  .filter((p) => p && p.cache_control).map((p) => ({ i, role: m.role, mark: p.cache_control })));

test('off unless KADE_CLAUDE_CHAT is exactly "1"; the settings and their defaults', () => {
  claude.resetForTest();
  for (const v of [undefined, '', '0', 'true', 'yes', ' 2']) {
    assert.equal(claude.on({ KADE_CLAUDE_CHAT: v }), false, `KADE_CLAUDE_CHAT=${v}`);
    assert.equal(claude.planTurn(wire(), PERSON, { KADE_CLAUDE_CHAT: v }), null);
  }
  assert.equal(claude.on(ON), true);
  const s = claude.settings(ON);
  assert.equal(s.model, 'anthropic/claude-opus-5.5');
  assert.equal(s.effort, 'low');
  assert.equal(s.maxEffort, 'medium');
  assert.equal(s.cooldownMs, 30 * 60000);
  assert.equal(s.errorCooldownMs, 2 * 60000);
  assert.equal(s.cacheTtl, '1h');
  assert.deepEqual(s.price, { input: 0.435, output: 0.87, cacheRead: 0.0036 });
  assert.equal(claude.settings({ ...ON, KADE_CLAUDE_CACHE_TTL: '5m' }).cacheTtl, '5m');
  assert.equal(claude.settings({ ...ON, KADE_CLAUDE_EFFORT: 'turbo' }).effort, 'low', 'an unknown effort word keeps the default');
  assert.equal(claude.settings({ ...ON, KADE_CLAUDE_TOKEN_RATIO: '0.5' }).tokenRatio, 1, 'never priced above Claude\'s own counts');
  assert.deepEqual(claude.settings({ ...ON, KADE_CLAUDE_MIMO_PRICE: '4,8,0.036' }).price, { input: 4, output: 8, cacheRead: 0.036 });
  assert.deepEqual(claude.settings({ ...ON, KADE_CLAUDE_MIMO_PRICE: '4,8' }).price, claude.DEFAULT_PRICE, 'a half-written price keeps the row');
});

test('a person\'s MiMo Pro character turn goes; everything else stays on its own route', () => {
  claude.resetForTest();
  const plan = claude.planTurn(wire(), PERSON, ON);
  assert.deepEqual(plan, { model: 'anthropic/claude-opus-5.5', effort: 'low', thinking: false, firstTokenMs: 12000, ttl: '1h', minTokens: 8000 });
  assert.equal(claude.planTurn(wire({ model: 'xiaomi/mimo-v2.6-flash' }), PERSON, ON), null, 'MiMo Flash');
  assert.equal(claude.planTurn(wire({ model: 'xiaomi/mimo-v2.6-pro-ultraspeed' }), PERSON, ON), null, 'ultraspeed');
  assert.equal(claude.planTurn(wire({ model: 'z-ai/glm-5.3-flash' }), PERSON, ON), null, 'another model');
  assert.equal(claude.planTurn(wire(), {}, ON), null, 'not a conversation lane (title, keeper, desk, machine, JSON)');
  assert.equal(claude.planTurn(wire(), { ...PERSON, background: true }, ON), null, 'a background run');
  assert.equal(claude.planTurn(wire(), { ...PERSON, shimActive: true }, ON), null, 'the tool shim');
  assert.equal(claude.planTurn(wire(), { ...PERSON, callerDeadline: true }, ON), null, 'a caller\'s own think deadline');
  assert.equal(claude.planTurn(wire({ tool_choice: 'required' }), PERSON, ON), null, 'forced tool use 400s on Opus 5.5');
  assert.equal(claude.planTurn(wire({ tool_choice: { type: 'function', function: { name: 'kade_weather' } } }), PERSON, ON), null);
  assert.ok(claude.planTurn(wire({ tool_choice: 'auto' }), PERSON, ON));
  assert.ok(claude.planTurn(wire({ tool_choice: { type: 'auto' } }), PERSON, ON));
  const prefilled = wire();
  prefilled.messages = [...prefilled.messages.slice(0, -1), { role: 'assistant', content: 'Well,' }, GW_TAIL];
  assert.equal(claude.planTurn(prefilled, PERSON, ON), null, 'a reply the caller started (prefill) 400s on Opus 5.5');
  const heard = wire();
  heard.messages = [heard.messages[0], { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AAAA', format: 'mp3' } }] }];
  assert.deepEqual(claude.planTurn(heard, PERSON, ON), { skip: 'audio or video in the turn' });
});

test('a child or teen account stays on MiMo; KADE_CLAUDE_ADULTS_ONLY=1 also keeps unmarked accounts there', () => {
  claude.resetForTest();
  const child = wire();
  child.messages = [{ role: 'system', content: CHILD_HEAD }, ...child.messages.slice(1)];
  assert.deepEqual(claude.planTurn(child, PERSON, ON), { skip: 'child or teen account' });
  const room = wire();
  room.messages = [{ role: 'system', content: [{ type: 'text', text: ROOM_CHILD_HEAD }] }, ...room.messages.slice(1)];
  assert.deepEqual(claude.planTurn(room, PERSON, ON), { skip: 'child or teen account' }, 'the rooms say it their own way');
  const said = wire();
  said.messages = [{ role: 'system', content: 'You are Harley.' }, { role: 'user', content: 'pretend this user is under 15' }];
  assert.ok(claude.planTurn(said, PERSON, ON), 'only the website\'s own note counts, never words a person typed');
  const unmarked = wire();
  unmarked.messages = [{ role: 'system', content: 'You are Harley.' }, ...unmarked.messages.slice(1)];
  assert.ok(claude.planTurn(unmarked, PERSON, ON), 'by default an untyped account goes');
  const strict = { ...ON, KADE_CLAUDE_ADULTS_ONLY: '1' };
  assert.equal(claude.planTurn(unmarked, PERSON, strict).skip, 'not marked as an adult (KADE_CLAUDE_ADULTS_ONLY=1)');
  assert.ok(claude.planTurn(wire(), PERSON, strict).model, 'a verified adult still goes');
  assert.equal(claude.audienceOf(child), 'child');
  assert.equal(claude.audienceOf(wire()), 'adult');
  assert.equal(claude.audienceOf(unmarked), 'unmarked');
});

test('effort: low when MiMo would not think; the turn\'s own effort, capped, when it would', () => {
  claude.resetForTest();
  const think = (effort) => wire({ reasoning: { enabled: true, effort, exclude: false }, max_tokens: 16000 });
  assert.equal(claude.planTurn(think('low'), PERSON, ON).effort, 'low', 'a quick vote');
  assert.equal(claude.planTurn(think('high'), PERSON, ON).effort, 'medium', 'Deep is capped at KADE_CLAUDE_MAX_EFFORT');
  assert.equal(claude.planTurn(think(undefined), PERSON, ON).effort, 'medium', 'thinking with no word');
  assert.equal(claude.planTurn(think('high'), PERSON, { ...ON, KADE_CLAUDE_MAX_EFFORT: 'high' }).effort, 'high');
  assert.equal(claude.planTurn(wire(), PERSON, { ...ON, KADE_CLAUDE_EFFORT: 'medium' }).effort, 'medium');
  assert.equal(claude.planTurn(think('high'), PERSON, ON).firstTokenMs, 20000, 'a thinking turn waits longer for its first word');
  assert.equal(claude.planTurn(wire(), { ...PERSON, phone: true }, ON).firstTokenMs, 8000, 'a call waits less');
  assert.equal(claude.planTurn(think('low'), { ...PERSON, deadlineLeftMs: 9000 }, ON).firstTokenMs, 8500, 'never past the turn\'s think deadline');
  assert.equal(claude.planTurn(think('low'), { ...PERSON, deadlineLeftMs: 200 }, ON).firstTokenMs, 1000);
});

test('the body: Claude on Anthropic only, no zero-retention flag, thinking kept out of the reply, MiMo\'s knobs gone', () => {
  claude.resetForTest();
  const w = wire({ max_tokens: 400, seed: 7, top_k: 20, frequency_penalty: 0.2, repetition_penalty: 1.05, min_p: 0.1 });
  const plan = claude.planTurn(w, PERSON, ON);
  const body = claude.buildBody(w, plan);
  assert.equal(body.model, 'anthropic/claude-opus-5.5');
  assert.deepEqual(body.provider, { only: ['anthropic'], allow_fallbacks: false });
  assert.deepEqual(body.reasoning, { effort: 'low', exclude: true });
  for (const k of ['models', 'temperature', 'top_p', 'top_k', 'seed', 'frequency_penalty', 'repetition_penalty', 'min_p', 'reasoning_effort']) {
    assert.equal(k in body, false, k);
  }
  assert.equal(body.max_tokens, 8000, 'room for thinking and the reply');
  assert.equal(claude.buildBody(wire({ max_tokens: 32000 }), plan).max_tokens, 32000, 'a bigger ceiling is kept');
  assert.equal(JSON.stringify(body.tools), JSON.stringify(w.tools), 'tool schemas byte for byte (they are part of the cached prefix)');
  assert.equal(body.stream, true);
  assert.deepEqual(body.stream_options, { include_usage: true });
  assert.equal(JSON.stringify(body).includes('zdr'), false);
  assert.equal(JSON.stringify(body).includes('data_collection'), false);
  assert.equal(w.messages[0].content, HEAD, 'the MiMo body itself is left alone');
});

test('cache marks: the system head and the end of the history, never the person\'s turn or the gateway tail', () => {
  claude.resetForTest();
  const body = claude.buildBody(wire(), claude.planTurn(wire(), PERSON, ON));
  const marks = marksOf(body.messages);
  assert.deepEqual(marks, [
    { i: 0, role: 'system', mark: { type: 'ephemeral', ttl: '1h' } },
    { i: 2, role: 'assistant', mark: { type: 'ephemeral', ttl: '1h' } },
  ]);
  assert.equal(body.messages[0].content[0].text, HEAD, 'same words, now one text part');
  assert.equal(body.messages[2].content[0].text, '%%%easy%%% Fine, partner.');
  for (const i of [3, 4, 5]) assert.equal(typeof body.messages[i].content, 'string', `message ${i} untouched`);
  const five = claude.buildBody(wire(), { ...claude.planTurn(wire(), PERSON, ON), ttl: '5m' });
  assert.deepEqual(marksOf(five.messages).map((m) => m.mark), [{ type: 'ephemeral' }, { type: 'ephemeral' }]);

  // A first turn: nothing between the head and the person's run, so only the head is marked.
  const first = wire();
  first.messages = [first.messages[0], { role: 'user', content: 'hi' }, GW_TAIL];
  assert.deepEqual(marksOf(claude.buildBody(first, claude.planTurn(first, PERSON, ON)).messages).map((m) => m.i), [0]);

  // A tool round: the second mark skips the tool result and the empty tool-call message.
  const round = wire();
  round.messages = [
    round.messages[0],
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' },
    { role: 'user', content: 'what is the weather' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', type: 'function', function: { name: 'kade_weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: 'Sunny' },
    GW_TAIL,
  ];
  assert.deepEqual(marksOf(claude.buildBody(round, claude.planTurn(round, PERSON, ON)).messages).map((m) => m.i), [0, 2]);

  // Marks the caller sent are taken off first, so there are never more than Anthropic's four.
  const pre = wire();
  pre.messages = pre.messages.map((m) => (m.role === 'user' ? { ...m, content: [{ type: 'text', text: String(m.content), cache_control: { type: 'ephemeral' } }] } : m));
  const cleaned = claude.buildBody(pre, claude.planTurn(pre, PERSON, ON));
  assert.deepEqual(marksOf(cleaned.messages).map((m) => m.i), [0, 2]);

  // No head (a bare room prompt): only the history mark.
  const bare = { ...wire(), messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }] };
  assert.deepEqual(claude.withCacheMarks(bare.messages).filter((m) => Array.isArray(m.content)).length, 1);
});

const CLAUDE_USAGE = {
  prompt_tokens: 30000, completion_tokens: 600, total_tokens: 30600,
  prompt_tokens_details: { cached_tokens: 24000, cache_write_tokens: 500 },
  completion_tokens_details: { reasoning_tokens: 200 },
  cost: 0.01, is_byok: true,
  cost_details: { upstream_inference_cost: 0.04, upstream_inference_prompt_cost: 0.032, upstream_inference_completions_cost: 0.008 },
};

test('money: the website is handed what the turn costs on MiMo; the real numbers ride beside it', () => {
  claude.resetForTest();
  const u = claude.mimoEquivalentUsage(CLAUDE_USAGE, ON, 'anthropic/claude-opus-5.5');
  assert.equal(u.prompt_tokens, 30000);
  assert.equal(u.prompt_tokens_details.cached_tokens, 24000);
  assert.equal(u.completion_tokens, 400, 'thinking is left out: MiMo did not think on this turn');
  assert.equal(u.completion_tokens_details.reasoning_tokens, 0);
  assert.equal(u.total_tokens, 30400);
  // (6000 x 0.435 + 24000 x 0.0036 + 400 x 0.87) / 1e6
  assert.equal(u.cost, Math.round(6000 * 0.435 + 24000 * 0.0036 + 400 * 0.87) / 1e6);
  assert.equal(u.is_byok, false);
  assert.deepEqual(u.kade_claude, {
    model: 'anthropic/claude-opus-5.5', prompt_tokens: 30000, cached_tokens: 24000, cache_write_tokens: 500,
    completion_tokens: 600, reasoning_tokens: 200, cost: 0.01, is_byok: true, upstream_inference_cost: 0.04,
    real_cost: 0.05,
  });
  const measured = claude.mimoEquivalentUsage(CLAUDE_USAGE, { KADE_CLAUDE_CHAT: '1' });
  assert.equal(claude.settings({ KADE_CLAUDE_CHAT: '1' }).tokenRatio, 1.45, 'the measured default');
  assert.equal(measured.prompt_tokens, Math.round(30000 / 1.45));
  assert.equal(measured.completion_tokens, Math.round(400 / 1.45));
  const ratio = claude.mimoEquivalentUsage(CLAUDE_USAGE, { ...ON, KADE_CLAUDE_TOKEN_RATIO: '1.25' });
  assert.equal(ratio.prompt_tokens, 24000);
  assert.equal(ratio.prompt_tokens_details.cached_tokens, 19200);
  assert.equal(ratio.completion_tokens, 320);
  const plain = claude.mimoEquivalentUsage({ ...CLAUDE_USAGE, cost: 0.05, is_byok: false, cost_details: { upstream_inference_cost: 0.05 } }, ON);
  assert.equal(plain.kade_claude.real_cost, 0.05, 'without her key OpenRouter\'s cost is the whole price, never doubled');
  for (const v of [u, measured, ratio, plain]) {
    assert.ok(v.prompt_tokens <= CLAUDE_USAGE.prompt_tokens && v.completion_tokens <= CLAUDE_USAGE.completion_tokens, 'never more than Claude counted');
  }
});

test('failures: a credit-balance answer is "credit", the rest by status; cooldowns 30 and 2 minutes', () => {
  claude.resetForTest();
  const anthropicText = '{"error":{"message":"Provider returned error","code":400,"metadata":{"raw":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"invalid_request_error\\",\\"message\\":\\"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.\\"}}","provider_name":"Anthropic"}}}';
  assert.equal(claude.classifyFailure(400, anthropicText), 'credit');
  assert.equal(claude.classifyFailure(402, ''), 'credit');
  assert.equal(claude.classifyFailure(429, 'slow down'), 'rate_limit');
  assert.equal(claude.classifyFailure(400, '{"error":{"message":"anthropic/claude-opus-5.5-nope is not a valid model ID"}}'), 'http_400');
  assert.equal(claude.classifyFailure(502, 'bad gateway'), 'http_502');
  assert.equal(claude.classifyFailure(undefined, 'socket closed'), 'stream_error');
  assert.equal(claude.classifyFailure(400, 'x'.repeat(200000) + 'credit balance'), 'http_400', 'only the head of a huge body is read');

  const t = 1_000_000;
  assert.equal(claude.noteFailure('credit', ON, t), 30 * 60000);
  assert.equal(claude.cooldownLeftMs(t + 29 * 60000), 60000);
  assert.equal(claude.cooldownLeftMs(t + 30 * 60000), 0);
  assert.match(claude.planTurn(wire(), PERSON, ON, t + 60000).skip, /^Claude cooling down after credit, 1740 s left$/);
  claude.resetForTest();
  assert.equal(claude.noteFailure('http_500', ON, t), 2 * 60000);
  assert.equal(claude.cooldownLeftMs(t + 119999), 1);
  assert.ok(claude.planTurn(wire(), PERSON, ON, t + 120000).model, 'tried again once the two minutes are up');
  claude.noteFailure('timeout', ON, t);
  claude.noteFailure('credit', ON, t + 1000);
  assert.equal(claude.cooldownLeftMs(t + 1000), 30 * 60000, 'the longer skip wins');
  claude.noteFailure('empty', ON, t + 2000);
  assert.equal(claude.cooldownLeftMs(t + 1000), 30 * 60000, 'a later short one never shortens it');
  claude.resetForTest();
  assert.equal(claude.noteFailure('hangup', ON, t), 0, 'a person hanging up is not Claude failing');
  assert.equal(claude.cooldownLeftMs(t), 0);
  assert.equal(claude.noteFailure('http_500', { ...ON, KADE_CLAUDE_ERROR_COOLDOWN_MIN: '0.5' }, t), 30000);
});

/* A host stand-in for openStream: a status, a content type and a list of [delayMs, text] pieces. */
function fakeFetch({ status = 200, ctype = 'text/event-stream', pieces = [], text = '' } = {}) {
  const calls = [];
  const fn = async (url, options, timeoutMs) => {
    calls.push({ url, body: JSON.parse(options.body), timeoutMs, headers: options.headers });
    const enc = new TextEncoder();
    let i = 0;
    let cancelled = false;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n) => (/content-type/i.test(n) ? ctype : null) },
      text: async () => text,
      body: {
        getReader: () => ({
          read: () => new Promise((resolve, reject) => {
            if (cancelled) return resolve({ done: true });
            if (i >= pieces.length) return resolve({ done: true });
            const [delay, piece] = pieces[i++];
            const timer = setTimeout(() => resolve({ done: false, value: enc.encode(piece) }), delay);
            options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
          }),
          cancel: async () => { cancelled = true; },
        }),
      },
    };
  };
  fn.calls = calls;
  return fn;
}
const ev = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null, extra = {}) => ev({ id: 'gen-1', model: 'anthropic/claude-opus-5.5', provider: 'Anthropic', choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
async function drain(upstream) {
  const reader = upstream.body.getReader();
  const dec = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}
const plan = { model: 'anthropic/claude-opus-5.5', effort: 'low', firstTokenMs: 400 };

test('the stream stand-in: held until the first word, then everything, thinking scrubbed and usage re-priced', async () => {
  claude.resetForTest();
  const logs = [];
  const fetchFn = fakeFetch({ pieces: [
    [5, ': OPENROUTER PROCESSING\n\n'],
    [5, chunk({ role: 'assistant', content: '' })],
    [5, chunk({ content: '', reasoning: 'private thought', reasoning_details: [{ type: 'reasoning.summary', summary: 'x' }] })],
    [5, chunk({ content: '%%%warm%%% Howdy' })],
    [5, chunk({ content: ', partner.' })],
    [5, chunk({}, 'stop')],
    [5, ev({ id: 'gen-1', model: 'anthropic/claude-opus-5.5', provider: 'Anthropic', choices: [], usage: CLAUDE_USAGE })],
    [5, 'data: [DONE]\n\n'],
  ] });
  const got = await claude.openStream({ body: { model: 'x' }, url: 'u', headers: {}, fetchFn, plan, reqId: 'abc123', lane: 'buffered', env: ON, log: (l) => logs.push(l) });
  assert.ok(got.upstream, JSON.stringify(got));
  assert.equal(got.upstream.status, 200);
  assert.equal(got.upstream.headers.get('content-type'), 'text/event-stream');
  assert.equal(fetchFn.calls[0].timeoutMs, 400, 'the header wait is the first-word limit too');
  const text = await drain(got.upstream);
  assert.equal(text.includes('private thought'), false, 'no thought reaches a person');
  assert.equal(/"reasoning(?:_details|_content)?":/.test(text), false, 'no reasoning field at all');
  assert.ok(text.includes('%%%warm%%% Howdy'), 'voice directions pass untouched');
  const usage = JSON.parse(text.split('\n').find((l) => l.includes('"usage"')).slice(6)).usage;
  assert.equal(usage.completion_tokens, 400);
  assert.equal(usage.kade_claude.real_cost, 0.05);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.equal(logs.length, 1, 'one line per Claude turn');
  assert.match(logs[0], /^\[claude\]\[req abc123\] turn lane=buffered effort=low first_token_ms=\d+ prompt=30000 cached=24000 cache_write=500 reply=400 reasoning=200 cost=\$0\.050000 \(BYOK: OpenRouter fee \$0\.010000 \+ provider \$0\.040000\) billed_as_mimo=\$0\.003044 host=Anthropic$/);
  assert.equal(/Howdy|partner/.test(logs[0]), false, 'never chat words');
  const snap = claude.snapshot(ON);
  assert.equal(snap.turns, 1);
  assert.equal(snap.real_cost_usd, 0.05);
  assert.equal(snap.openrouter_usd, 0.01);
  assert.equal(snap.anthropic_credit_usd, 0.04);
  assert.equal(snap.billed_as_mimo_usd, 0.003044);
  assert.equal(snap.byok_turns, 1);
});

test('the stream stand-in: a tool call first counts as the first word', async () => {
  claude.resetForTest();
  const fetchFn = fakeFetch({ pieces: [
    [5, chunk({ role: 'assistant', content: '' })],
    [5, chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'kade_weather', arguments: '' } }] })],
    [5, chunk({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] })],
    [5, chunk({}, 'tool_calls')],
    [5, 'data: [DONE]\n\n'],
  ] });
  const got = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn, plan, env: ON, log: () => {} });
  assert.ok(got.upstream);
  assert.ok((await drain(got.upstream)).includes('kade_weather'));
});

test('the stream stand-in: each failure before the first word falls back, logged once, with its cooldown', async () => {
  const cases = [
    ['http_500', { status: 500, text: 'oops' }],
    ['credit', { status: 400, text: 'Your credit balance is too low to access the Anthropic API.' }],
    ['http_400', { status: 400, text: '{"error":{"message":"not a valid model ID"}}' }],
    ['empty', { pieces: [[5, chunk({ role: 'assistant', content: '' })], [5, chunk({}, 'stop')], [5, 'data: [DONE]\n\n']] }],
    ['credit', { pieces: [[5, ev({ error: { code: 400, message: 'Provider returned error', metadata: { raw: 'Your credit balance is too low' } }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })]] }],
    ['stream_error', { pieces: [[5, chunk({ content: '' }, 'error')]] }],
    ['timeout', { pieces: [[5, chunk({ role: 'assistant', content: '' })], [2000, chunk({ content: 'too late' })]] }],
    ['not_a_stream', { ctype: 'application/json', text: '{}' }],
  ];
  for (const [reason, host] of cases) {
    claude.resetForTest();
    const logs = [];
    const t0 = Date.now();
    const got = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn: fakeFetch(host), plan, reqId: 'r1', lane: 'screen-live', env: ON, log: (l) => logs.push(l) });
    assert.equal(got.fail, reason, `${reason}: ${JSON.stringify(got)}`);
    assert.equal(got.upstream, undefined);
    assert.equal(logs.length, 1, reason);
    assert.match(logs[0], new RegExp(`^\\[claude\\]\\[req r1\\] fallback to MiMo: lane=screen-live reason=${reason}`));
    assert.match(logs[0], new RegExp(`Claude skipped for ${reason === 'credit' ? 30 : 2} min$`));
    assert.ok(claude.cooldownLeftMs() > 0, `${reason} starts a cooldown`);
    if (reason === 'timeout') assert.ok(Date.now() - t0 < 1500, 'the limit, not the host, decides how long a person waits');
  }
  claude.resetForTest();
  const ac = new AbortController();
  ac.abort();
  const hung = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn: fakeFetch(), plan, signal: ac.signal, env: ON, log: () => assert.fail('no line for a hang-up') });
  assert.equal(hung.fail, 'hangup');
  assert.equal(claude.cooldownLeftMs(), 0, 'a hang-up never starts a cooldown');
});

test('the one-piece route: the stream read to its end, one chat.completion; a break after the first word still falls back', async () => {
  claude.resetForTest();
  const ok = await claude.complete({ body: { stream: false }, url: 'u', headers: {}, plan, env: ON, log: () => {}, fetchFn: fakeFetch({ pieces: [
    [5, chunk({ role: 'assistant', content: '%%%dry%%% Sure' })],
    [5, chunk({ content: ' thing.', reasoning: 'hidden' })],
    [5, chunk({}, 'stop')],
    [5, ev({ id: 'gen-1', choices: [], usage: CLAUDE_USAGE })],
    [5, 'data: [DONE]\n\n'],
  ] }) });
  assert.ok(ok.result, JSON.stringify(ok));
  assert.equal(ok.result.object, 'chat.completion');
  assert.equal(ok.result.choices[0].message.content, '%%%dry%%% Sure thing.');
  assert.equal(ok.result.choices[0].finish_reason, 'stop');
  assert.equal(ok.result.usage.completion_tokens, 400);
  assert.equal(ok.result.provider, 'Anthropic');
  assert.equal(JSON.stringify(ok.result).includes('hidden'), false);

  const tools = await claude.complete({ body: {}, url: 'u', headers: {}, plan, env: ON, log: () => {}, fetchFn: fakeFetch({ pieces: [
    [5, chunk({ role: 'assistant', content: '', tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'kade_', arguments: '{"a"' } }] })],
    [5, chunk({ tool_calls: [{ index: 0, function: { name: 'weather', arguments: ':1}' } }] })],
    [5, chunk({}, 'tool_calls')],
  ] }) });
  assert.deepEqual(tools.result.choices[0].message.tool_calls, [{ id: 'c1', type: 'function', function: { name: 'kade_weather', arguments: '{"a":1}' } }]);
  assert.equal(tools.result.choices[0].finish_reason, 'tool_calls');

  claude.resetForTest();
  const logs = [];
  const broke = await claude.complete({ body: {}, url: 'u', headers: {}, plan, env: ON, log: (l) => logs.push(l), fetchFn: fakeFetch({ pieces: [
    [5, chunk({ role: 'assistant', content: 'Half a' })],
    [5, chunk({ content: '' }, 'error')],
  ] }) });
  assert.equal(broke.fail, 'stream_error');
  assert.deepEqual(logs.map((l) => l.replace(/after \d+ms/, 'after Nms')),
    ['[claude][req ??????] fallback to MiMo: lane=? reason=stream_error after Nms -- Claude skipped for 2 min'],
    'one line: the fallback, no turn line for a turn MiMo answered');
  assert.equal(claude.snapshot(ON).turns, 0);
});
