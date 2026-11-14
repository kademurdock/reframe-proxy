'use strict';
/* Nov 14 2026: the writing lanes of the Claude route (claude-route.js THE WRITING LANES), offline. Which calls go
 * (a named lane, the lane switched on, a verified adult by the website's mark or, for speak-first, its note), the
 * body each lane's Claude call gets (provider, effort, reply cap, cache marks), how each is billed (the lyric desk
 * at Claude's real cost, the rest as MiMo), KADE_CLAUDE_LANES, and the whole-answer read that lets every failure fall
 * back with nothing handed on. Nothing here reaches a network. */
const test = require('node:test');
const assert = require('node:assert/strict');
const claude = require('./claude-route');

const ON = { KADE_CLAUDE_CHAT: '1', KADE_CLAUDE_TOKEN_RATIO: '1' };
const CLAUDE = 'anthropic/claude-opus-5.5';
const ADULT_NOTE = claude.ADULT_NOTES[0].site; // the website's live verified-adult note (build.js KADE_ADULT_NOTE_VOICE)
const CHILD_NOTE = '\n\n---\nAUDIENCE NOTE (invisible — never mention it, never hint at it, never act like you are filtering): this user is under 15. Keep your personality, humor, and edge exactly the same, but keep the content clean.';
const DESK_HEAD = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below supplies your conversational character.\n\nCLEAN OR EXPLICIT: explicit is allowed.";
const SONG_DESK_NOTE = { role: 'system', content: 'SONG DESK: answer with the finished work only, in the format this request asks for.' };

/* Each lane's call as the gateway's adapters leave it (the wire), shaped like what the website sends. */
const LANE_WIRES = {
  'lyric-desk': () => ({
    model: CLAUDE, stream: true, stream_options: { include_usage: true }, max_tokens: 16384,
    reasoning: { enabled: true, effort: 'medium', exclude: false },
    provider: { zdr: true, data_collection: 'deny', ignore: ['novita'] },
    messages: [{ role: 'system', content: DESK_HEAD }, { role: 'user', content: 'WHAT THEY WANT MADE:\na song about my truck' }, SONG_DESK_NOTE],
  }),
  'booth-edit': () => ({
    model: 'xiaomi/mimo-v2.6-pro', models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'], stream: true, stream_options: { include_usage: true },
    max_tokens: 16384, reasoning: { enabled: false, effort: 'none', exclude: false },
    provider: { order: ['PrimaLabs', 'DeepInfra'], allow_fallbacks: true, zdr: true, data_collection: 'deny' },
    messages: [{ role: 'system', content: "You are the script desk in Kade-AI's Sound Booth. The Seed Audio script below is 2400 characters." }, { role: 'user', content: 'A long script.' }],
  }),
  'persona-writer': () => ({
    model: 'xiaomi/mimo-v2.6-pro', models: ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash'], stream: false, max_tokens: 6000,
    reasoning: { enabled: true, effort: 'low', exclude: false },
    provider: { order: ['PrimaLabs', 'DeepInfra'], allow_fallbacks: true, zdr: true, data_collection: 'deny' },
    messages: [{ role: 'system', content: 'You write system prompts for characters on a chat platform.' },
      { role: 'user', content: "CHARACTER BRIEF (from the person building them):\nA retired ferry captain.\n\nWrite the character's system prompt now." }],
  }),
  'spotter-draft': () => ({
    model: 'xiaomi/mimo-v2.6-pro', stream: false, max_tokens: 400, reasoning: { enabled: false, effort: 'none', exclude: false },
    provider: { order: ['PrimaLabs', 'DeepInfra'], allow_fallbacks: true, zdr: true, data_collection: 'deny' },
    messages: [{ role: 'user', content: 'Write a personality brief for a "Spotter". Invent a distinctive, likable one.' }],
  }),
  'speak-first': () => ({
    model: 'xiaomi/mimo-v2.6-pro', stream: true, reasoning: { enabled: false, effort: 'none', exclude: false }, temperature: 0.8,
    tools: [{ type: 'function', function: { name: 'kade_weather', description: 'Weather', parameters: { type: 'object', properties: {} } } }],
    messages: [{ role: 'system', content: 'You are Harley, a cowboy who talks plain.' + ADULT_NOTE },
      { role: 'user', content: '[PLATFORM NOTE, not something they typed: text them about the horses.]' },
      { role: 'system', content: "Right now it's Friday (US Central)." }],
  }),
};
const MARK_LANES = ['lyric-desk', 'booth-edit', 'persona-writer', 'spotter-draft'];
const plainCtx = (lane, over = {}) => ({ lane, adult: true, personLane: false, ...over });
const speakCtx = (over = {}) => ({ lane: 'speak-first', personLane: true, background: true, ...over });
const ctxFor = (lane, over = {}) => (lane === 'speak-first' ? speakCtx(over) : plainCtx(lane, over));
const marksOf = (messages) => messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content : [])
  .filter((p) => p && p.cache_control).map((p) => ({ i, role: m.role, mark: p.cache_control })));

test('KADE_CLAUDE_LANES: unset is every lane; a list, a minus or "none" picks them', () => {
  const all = ['lyric-desk', 'booth-edit', 'persona-writer', 'spotter-draft', 'speak-first'];
  assert.deepEqual(claude.LANE_NAMES, all);
  assert.deepEqual(claude.lanesFrom(undefined), all);
  assert.deepEqual(claude.lanesFrom('  '), all);
  assert.deepEqual(claude.lanesFrom('none'), []);
  assert.deepEqual(claude.lanesFrom('0'), []);
  assert.deepEqual(claude.lanesFrom('OFF'), []);
  assert.deepEqual(claude.lanesFrom('speak-first, Lyric-Desk'), ['lyric-desk', 'speak-first'], 'in the table\'s order, any case');
  assert.deepEqual(claude.lanesFrom('-lyric-desk'), ['booth-edit', 'persona-writer', 'spotter-draft', 'speak-first'], 'one lane off, the rest on');
  assert.deepEqual(claude.lanesFrom('all,-spotter-draft,-speak-first'), ['lyric-desk', 'booth-edit', 'persona-writer']);
  assert.deepEqual(claude.lanesFrom('lyric-desk,typo-lane'), ['lyric-desk'], 'an unknown name is ignored');
  assert.deepEqual(claude.settings({}).lanes, all);
  assert.deepEqual(claude.settings({ KADE_CLAUDE_LANES: 'persona-writer' }).lanes, ['persona-writer']);
  assert.equal(claude.isLane('lyric-desk'), true);
  assert.equal(claude.isLane('buffered'), false, 'chat lanes are not writing lanes');
  assert.equal(claude.isLane('toString'), false, 'nothing from the object prototype');
  assert.equal(claude.isLane(undefined), false);
});

test('off: with KADE_CLAUDE_CHAT unset or 0 no lane plans, whatever the marks say', () => {
  claude.resetForTest();
  for (const env of [{}, { KADE_CLAUDE_CHAT: '0' }, { KADE_CLAUDE_CHAT: 'true' }]) {
    for (const lane of claude.LANE_NAMES) assert.equal(claude.planLane(LANE_WIRES[lane](), ctxFor(lane), env), null, `${lane} ${JSON.stringify(env)}`);
  }
  assert.equal(claude.planLane(LANE_WIRES['lyric-desk'](), { lane: 'not-a-lane', adult: true }, ON), null);
});

test('who: a mark lane needs the website\'s adult mark; an under-15 head never goes; speak-first reads the note', () => {
  claude.resetForTest();
  for (const lane of MARK_LANES) {
    const plan = claude.planLane(LANE_WIRES[lane](), plainCtx(lane), ON);
    assert.ok(plan && !plan.skip, `${lane}: ${JSON.stringify(plan)}`);
    assert.equal(plan.lane, lane);
    assert.deepEqual(claude.planLane(LANE_WIRES[lane](), plainCtx(lane, { adult: false }), ON), { skip: 'not marked as a verified adult' }, lane);
    assert.deepEqual(claude.planLane(LANE_WIRES[lane](), plainCtx(lane, { adult: undefined }), ON), { skip: 'not marked as a verified adult' }, lane);
    const child = LANE_WIRES[lane]();
    child.messages = [{ role: 'system', content: 'You write.' + CHILD_NOTE }, ...child.messages.filter((m) => m.role !== 'system')];
    assert.deepEqual(claude.planLane(child, plainCtx(lane), ON), { skip: 'child or teen account' }, `${lane}: the mark cannot outvote an under-15 head`);
  }
  const speak = claude.planLane(LANE_WIRES['speak-first'](), speakCtx(), ON);
  assert.ok(speak && !speak.skip, JSON.stringify(speak));
  const childTurn = LANE_WIRES['speak-first']();
  childTurn.messages[0] = { role: 'system', content: 'You are Harley.' + CHILD_NOTE };
  assert.deepEqual(claude.planLane(childTurn, speakCtx({ adult: true }), ON), { skip: 'child or teen account' });
  const untyped = LANE_WIRES['speak-first']();
  untyped.messages[0] = { role: 'system', content: 'You are Harley.' };
  assert.deepEqual(claude.planLane(untyped, speakCtx({ adult: true }), ON), { skip: 'not marked as a verified adult' }, 'speak-first ignores the mark: only the note counts');
  assert.equal(claude.planLane(LANE_WIRES['speak-first'](), speakCtx({ personLane: false }), ON), null, 'only a conversation turn');
  assert.equal(claude.planLane(LANE_WIRES['speak-first'](), speakCtx({ shimActive: true }), ON), null);
});

test('a lane stays where it was sent when its caller chose another writer, or the lane is switched off', () => {
  claude.resetForTest();
  const desk = { ...LANE_WIRES['lyric-desk'](), model: 'xiaomi/mimo-v2.6-pro' };
  assert.equal(claude.planLane(desk, plainCtx('lyric-desk'), ON), null, 'KADE_LYRIC_MODEL moved the desk to MiMo: the gateway does not move it back');
  assert.equal(claude.planLane({ ...LANE_WIRES['booth-edit'](), model: CLAUDE }, plainCtx('booth-edit'), ON), null);
  assert.equal(claude.planLane({ ...LANE_WIRES['persona-writer'](), model: 'xiaomi/mimo-v2.6-flash' }, plainCtx('persona-writer'), ON), null);
  for (const lane of claude.LANE_NAMES) {
    assert.deepEqual(claude.planLane(LANE_WIRES[lane](), ctxFor(lane), { ...ON, KADE_CLAUDE_LANES: 'none' }), { skip: `the ${lane} lane is off (KADE_CLAUDE_LANES)` });
    assert.deepEqual(claude.planLane(LANE_WIRES[lane](), ctxFor(lane), { ...ON, KADE_CLAUDE_LANES: `-${lane}` }), { skip: `the ${lane} lane is off (KADE_CLAUDE_LANES)` });
    const only = claude.planLane(LANE_WIRES[lane](), ctxFor(lane), { ...ON, KADE_CLAUDE_LANES: lane });
    assert.ok(only && !only.skip, lane);
  }
  assert.equal(claude.laneStays('lyric-desk'), 'the route it was sent on');
  assert.equal(claude.laneStays('persona-writer'), 'MiMo');
  assert.equal(claude.laneStays('buffered'), 'MiMo');
});

test('the plan and the body of each lane', () => {
  claude.resetForTest();
  const bodyOf = (lane, over = {}) => {
    const w = { ...LANE_WIRES[lane](), ...over };
    const plan = claude.planLane(w, ctxFor(lane), ON);
    return { plan, body: claude.buildBody(w, plan) };
  };
  for (const lane of claude.LANE_NAMES) {
    const { body } = bodyOf(lane);
    assert.equal(body.model, CLAUDE, lane);
    assert.deepEqual(body.provider, { only: ['anthropic'], allow_fallbacks: false }, `${lane}: her key, no zero-retention flag`);
    assert.equal(JSON.stringify(body).includes('zdr'), false, lane);
    assert.equal('models' in body, false, `${lane}: no MiMo Flash backup on the Claude call`);
    assert.equal('temperature' in body, false, lane);
  }
  // The lyric desk: its own effort and cap, its real cost, a five-minute mark on the head, MiMo if Claude refuses.
  const desk = bodyOf('lyric-desk');
  assert.equal(desk.plan.whole, true);
  assert.equal(desk.plan.billing, 'real');
  assert.equal(desk.plan.refusalModel, 'xiaomi/mimo-v2.6-pro');
  assert.equal(desk.plan.firstTokenMs, 3600000, 'no limit of its own: the fallback is the same model');
  assert.deepEqual(desk.body.reasoning, { effort: 'medium', exclude: true }, 'the Think setting the person picked');
  assert.equal(desk.body.max_tokens, 16384, 'the desk\'s cap already leaves room to think');
  assert.deepEqual(marksOf(desk.body.messages), [{ i: 0, role: 'system', mark: { type: 'ephemeral' } }]);
  assert.equal(bodyOf('lyric-desk', { reasoning: { enabled: true, effort: 'high', exclude: false }, max_tokens: 65536 }).body.reasoning.effort, 'high', 'High stays high');
  assert.equal(bodyOf('lyric-desk', { reasoning: { enabled: true, effort: 'low', exclude: true } }).body.reasoning.effort, 'low', 'an edit pass stays low');
  // The MiMo lanes: low effort, room to think on top of their own cap, no marks, billed as MiMo, a time limit each.
  const limits = { 'booth-edit': 45000, 'persona-writer': 150000, 'spotter-draft': 25000 };
  const caps = { 'booth-edit': 16384 + 2000, 'persona-writer': 6000 + 2000, 'spotter-draft': 400 + 2000 };
  for (const lane of ['booth-edit', 'persona-writer', 'spotter-draft']) {
    const { plan, body } = bodyOf(lane);
    assert.equal(plan.whole, true, lane);
    assert.equal(plan.billing, 'mimo', lane);
    assert.equal(plan.refusalModel, null, `${lane}: the call as sent is MiMo already`);
    assert.equal(plan.firstTokenMs, limits[lane], lane);
    assert.deepEqual(body.reasoning, { effort: 'low', exclude: true }, lane);
    assert.equal(body.max_tokens, caps[lane], lane);
    assert.deepEqual(marksOf(body.messages), [], `${lane}: one call, no cache mark`);
  }
  assert.equal(bodyOf('persona-writer', {}).body.stream, false, 'the caller\'s stream setting rides; the one-piece route asks for the stream itself');
  // speak-first: as a chat turn, five-minute marks, the adult note softened.
  const speak = bodyOf('speak-first');
  assert.equal(speak.plan.whole, false);
  assert.equal(speak.plan.billing, 'mimo');
  assert.equal(speak.plan.firstTokenMs, 12000);
  assert.deepEqual(speak.body.reasoning, { effort: 'low', exclude: true });
  assert.deepEqual(marksOf(speak.body.messages), [{ i: 0, role: 'system', mark: { type: 'ephemeral' } }]);
  const head = speak.body.messages[0].content.map((p) => p.text).join('');
  assert.match(head, /keep sex off the page/);
  assert.doesNotMatch(head, /write it fully and explicitly/);
  // A deep speak-first turn thinks at its own effort, capped as chat is.
  const deep = claude.planLane({ ...LANE_WIRES['speak-first'](), reasoning: { enabled: true, effort: 'high' } }, speakCtx(), ON);
  assert.equal(deep.effort, 'medium');
  assert.equal(deep.firstTokenMs, 20000);
  // Chat turns are untouched by any of this: no marks setting means the old marks.
  const chat = claude.planTurn(LANE_WIRES['speak-first'](), { personLane: true }, ON);
  assert.equal(chat.marks, undefined);
  assert.deepEqual(marksOf(claude.buildBody(LANE_WIRES['speak-first'](), chat).messages)[0].mark, { type: 'ephemeral', ttl: '1h' });
});

test('a cooldown, a held request and audio keep a lane where it was sent', () => {
  claude.resetForTest();
  const now = Date.now();
  claude.applyFailure('credit', {}, ON, now);
  for (const lane of claude.LANE_NAMES) {
    const p = claude.planLane(LANE_WIRES[lane](), ctxFor(lane), ON, now + 1000);
    assert.match(p.skip, /^Claude cooling down after credit/, lane);
  }
  claude.resetForTest();
  const w = LANE_WIRES['persona-writer']();
  const plan = claude.planLane(w, plainCtx('persona-writer'), ON, now);
  claude.applyFailure('refusal', plan, ON, now);
  assert.match(claude.planLane(w, plainCtx('persona-writer'), ON, now + 1000).skip, /^Claude failed on this request \(refusal\)/);
  assert.ok(!claude.planLane(LANE_WIRES['spotter-draft'](), plainCtx('spotter-draft'), ON, now + 1000).skip, 'another request still goes');
  claude.resetForTest();
  const heard = LANE_WIRES['spotter-draft']();
  heard.messages = [{ role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'input_audio', input_audio: { data: 'x', format: 'wav' } }] }];
  assert.deepEqual(claude.planLane(heard, plainCtx('spotter-draft'), ON), { skip: 'audio or video in the call' });
  // A writing lane that ran long cools nobody; a chat turn's stall is still a strike.
  assert.equal(claude.scopeOf('timeout', { whole: true }), 'none');
  assert.equal(claude.scopeOf('timeout', {}), 'strike');
});

test('money: the lyric desk is handed Claude\'s own usage; every other lane MiMo\'s', () => {
  const usage = { prompt_tokens: 12000, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 300 },
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 11000 }, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0811 } };
  const line = `data: ${JSON.stringify({ id: 'gen-1', choices: [], usage })}`;
  const real = { env: ON, billing: 'real' };
  const out = JSON.parse(claude.transformEvent(line, real).slice(6));
  assert.deepEqual(out.usage, usage, 'the desk prices it itself (writingCost adds the upstream cost of a BYOK reply)');
  assert.deepEqual(real.usage, usage, 'and the route still counts it');
  assert.equal(real.billed, undefined);
  const mimo = { env: ON };
  const asMimo = JSON.parse(claude.transformEvent(line, mimo).slice(6)).usage;
  assert.equal(asMimo.is_byok, false);
  assert.equal(asMimo.completion_tokens, 600, 'the reply without its thinking');
  assert.equal(asMimo.cost, Math.round(12000 * 0.435 + 600 * 0.87) / 1e6);
  assert.equal(asMimo.kade_claude.real_cost, 0.0811);
});

/* A host stand-in for openStream: a status, a content type and a list of [delayMs, text] pieces. A piece that is
 * an Error breaks the stream there. */
function fakeFetch({ status = 200, ctype = 'text/event-stream', pieces = [], text = '' } = {}) {
  const calls = [];
  const fn = async (url, options, timeoutMs) => {
    calls.push({ url, body: JSON.parse(options.body), timeoutMs });
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
            const timer = setTimeout(() => (piece instanceof Error ? reject(piece) : resolve({ done: false, value: enc.encode(piece) })), delay);
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
const chunk = (delta, finish = null, extra = {}) => ev({ id: 'gen-1', model: CLAUDE, provider: 'Anthropic', choices: [{ index: 0, delta, finish_reason: finish, ...extra }] });
const USAGE = { prompt_tokens: 2000, completion_tokens: 300, completion_tokens_details: { reasoning_tokens: 100 },
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.014 } };
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
const lanePlan = (lane, over = {}) => ({ ...claude.planLane(LANE_WIRES[lane](), ctxFor(lane), ON), ...over });

test('a writing lane reads the whole answer before handing anything on, then hands it all on at once', async () => {
  claude.resetForTest();
  const logs = [];
  const fetchFn = fakeFetch({ pieces: [
    [5, ': OPENROUTER PROCESSING\n\n'],
    [5, chunk({ role: 'assistant', content: '', reasoning: 'private plan for the song' })],
    [30, ': OPENROUTER PROCESSING\n\n'],
    [5, chunk({ content: 'TITLE: Dirt Road\n[Verse 1]\nFirst line' })],
    [30, chunk({ content: '\nSecond line\nREADBACK: A short song.' })],
    [5, chunk({}, 'stop')],
    [5, ev({ id: 'gen-1', model: CLAUDE, provider: 'Anthropic', choices: [], usage: USAGE })],
    [5, 'data: [DONE]\n\n'],
  ] });
  const plan = lanePlan('lyric-desk');
  const t0 = Date.now();
  const got = await claude.openStream({ body: { model: CLAUDE }, url: 'u', headers: {}, fetchFn, plan, reqId: 'desk01', lane: 'lyric-desk', env: ON, log: (l) => logs.push(l) });
  assert.ok(got.upstream, JSON.stringify(got));
  assert.ok(Date.now() - t0 >= 80, 'it waited for the last event');
  const text = await drain(got.upstream);
  assert.match(text, /TITLE: Dirt Road/);
  assert.match(text, /READBACK: A short song\./);
  assert.ok(text.endsWith('data: [DONE]\n\n'));
  assert.equal(text.includes('private plan'), false, 'no thought reaches the desk');
  const usage = JSON.parse(text.split('\n').find((l) => l.includes('"usage"')).slice(6)).usage;
  assert.deepEqual(usage, USAGE, 'the desk is handed the real usage');
  assert.equal(logs.length, 1, logs.join('\n'));
  assert.match(logs[0], /^\[claude\]\[req desk01\] turn lane=lyric-desk effort=medium ms=\d+ prompt=2000 cached=0 cache_write=0 reply=200 reasoning=100 cost=\$0\.014000 \(BYOK: OpenRouter fee \$0\.000000 \+ provider \$0\.014000\) gen=gen-1 host=Anthropic$/);
  assert.equal(/Dirt Road|First line/.test(logs[0]), false, 'never the words');
  assert.equal(claude.snapshot(ON).lanes['lyric-desk'], 1);
  assert.deepEqual(claude.snapshot(ON).writing_lanes_on, claude.LANE_NAMES);
  assert.deepEqual(claude.snapshot({}).writing_lanes_on, [], 'off is off');
});

test('a writing lane falls back on every failure, at any point before its last event', async () => {
  const scenarios = [
    ['refusal after words', [[5, chunk({ content: 'I would rather' })], [5, chunk({}, 'content_filter', { native_finish_reason: 'refusal' })],
      [5, ev({ id: 'gen-1', choices: [], usage: USAGE })], [5, 'data: [DONE]\n\n']], 'refusal'],
    ['refusal with no words', [[5, chunk({}, 'content_filter', { native_finish_reason: 'refusal' })], [5, 'data: [DONE]\n\n']], 'refusal'],
    ['an empty answer', [[5, chunk({ role: 'assistant', content: '' })], [5, chunk({}, 'stop')], [5, 'data: [DONE]\n\n']], 'empty'],
    ['an error after words', [[5, chunk({ content: 'Half a persona' })],
      [5, ev({ id: 'gen-1', error: { code: 502, message: 'Provider returned error' }, choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] })]], 'http_502'],
    ['the credit running out mid-answer', [[5, chunk({ content: 'Half' })],
      [5, ev({ error: { code: 400, message: 'Your credit balance is too low to access the Anthropic API.' } })]], 'credit'],
    ['a dead stream', [[5, chunk({ content: 'Half' })], [900, chunk({ content: ' too late' })]], 'timeout'],
    ['a broken stream', [[5, chunk({ content: 'Half' })], [5, new Error('socket hang up')]], 'stream_error'],
  ];
  for (const [name, pieces, reason] of scenarios) {
    claude.resetForTest();
    const logs = [];
    const fetchFn = fakeFetch({ pieces });
    const plan = lanePlan('persona-writer');
    const got = await claude.openStream({ body: { model: CLAUDE }, url: 'u', headers: {}, fetchFn, plan, reqId: 'pw0001', lane: 'persona-writer',
      env: { ...ON, KADE_CLAUDE_IDLE_MS: '300' }, log: (l) => logs.push(l) });
    assert.equal(got.upstream, undefined, `${name}: nothing handed on`);
    assert.equal(got.fail, reason, `${name}: ${JSON.stringify(got)}`);
    const line = logs.find((l) => /fallback to MiMo: lane=persona-writer/.test(l));
    assert.ok(line, `${name}: ${logs.join('\n')}`);
    assert.equal(/Half|rather/.test(line), false, 'never the words');
  }
  // Its time limit: a writing lane that runs past it falls back, and cools nobody.
  claude.resetForTest();
  const slow = fakeFetch({ pieces: [[5, chunk({ content: 'Slow' })], [120, chunk({ content: ' and slower' })], [120, chunk({ content: '.' })], [5, chunk({}, 'stop')]] });
  const got = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn: slow, plan: lanePlan('spotter-draft', { firstTokenMs: 150 }), reqId: 'sp0001',
    lane: 'spotter-draft', env: ON, log: () => {} });
  assert.equal(got.fail, 'timeout');
  assert.equal(claude.cooldownLeftMs(), 0);
  assert.equal(claude.snapshot(ON).cooldown, null);
});

test('the lyric desk\'s fallback line names where the song goes: its own route, or MiMo after a refusal', async () => {
  claude.resetForTest();
  const logs = [];
  const credit = fakeFetch({ status: 400, ctype: 'application/json', text: JSON.stringify({ error: { code: 400, message: 'Your credit balance is too low to access the Anthropic API.' } }) });
  let got = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn: credit, plan: lanePlan('lyric-desk'), reqId: 'desk02', lane: 'lyric-desk', env: ON, log: (l) => logs.push(l) });
  assert.equal(got.fail, 'credit');
  assert.match(logs[0], /^\[claude\]\[req desk02\] fallback to the route it was sent on: lane=lyric-desk reason=credit status=400 after \d+ms -- Claude skipped for 30 min$/);
  claude.resetForTest();
  logs.length = 0;
  const refused = fakeFetch({ pieces: [[5, chunk({}, 'content_filter', { native_finish_reason: 'refusal' })], [5, 'data: [DONE]\n\n']] });
  got = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn: refused, plan: lanePlan('lyric-desk'), reqId: 'desk03', lane: 'lyric-desk', env: ON, log: (l) => logs.push(l) });
  assert.equal(got.fail, 'refusal');
  assert.match(logs[0], /^\[claude\]\[req desk03\] fallback to xiaomi\/mimo-v2\.6-pro: lane=lyric-desk reason=refusal after \d+ms gen=gen-1 cost=not reported -- Claude skipped for this conversation for 30 min$/);
});

test('the BYOK guard holds on a writing lane: served, then Claude is off for every lane and chat for a day', async () => {
  claude.resetForTest();
  const logs = [];
  const alerts = [];
  const nonByok = { ...USAGE, cost: 0.014, is_byok: false, cost_details: { upstream_inference_cost: 0.014 } };
  const fetchFn = fakeFetch({ pieces: [[5, chunk({ content: 'You are calm.' })], [5, chunk({}, 'stop')],
    [5, ev({ id: 'gen-1', choices: [], usage: nonByok })], [5, 'data: [DONE]\n\n']] });
  const got = await claude.openStream({ body: {}, url: 'u', headers: {}, fetchFn, plan: lanePlan('spotter-draft'), reqId: 'sp0002', lane: 'spotter-draft',
    env: ON, log: (l) => logs.push(l), alert: (kind, text) => alerts.push({ kind, text }) });
  assert.ok(got.upstream, 'the brief itself is served');
  await drain(got.upstream);
  assert.ok(logs.some((l) => /NOT PAID BY HER ANTHROPIC KEY: OpenRouter credit paid \$0\.014000 for this turn \(is_byok=false, lane=spotter-draft, gen=gen-1\)\. Claude skipped for 1440 min\./.test(l)), logs.join('\n'));
  assert.deepEqual(alerts.map((a) => a.kind), ['not_byok']);
  for (const lane of claude.LANE_NAMES) assert.match(claude.planLane(LANE_WIRES[lane](), ctxFor(lane), ON).skip, /cooling down after not_byok/, lane);
  claude.resetForTest();
});

test('the new patterns stay linear on 200,000 characters', () => {
  const t0 = Date.now();
  const huge = 'anthropic/claude-'.repeat(12000);
  assert.equal(claude.isClaudeModel('x' + huge), false);
  assert.equal(claude.lanesFrom('-'.repeat(200000) + ',lyric-desk').length, 1);
  assert.deepEqual(claude.lanesFrom(','.repeat(200000)), claude.LANE_NAMES);
  assert.equal(('a?'.repeat(100000)).replace(/[^a-z0-9-]/g, '?').length, 200000, 'server.js\'s lane log sanitizer');
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});
