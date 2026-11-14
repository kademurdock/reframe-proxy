'use strict';
/* Nov 14 2026: the writing lanes on the wire (claude-route.js THE WRITING LANES). Boots the real gateway against a
 * fake host on 127.0.0.1 and sends each lane's call the way the website sends it. Nothing paid.
 *  - switch off: a marked call leaves byte for byte as the same call left origin/main 14974ab unmarked (the fixture
 *    test-fixtures/claude-lanes-off-golden.json was written by this file against that commit's server.js), with the
 *    route off, with every lane off, for a person not marked adult, and for an under-15 head;
 *  - switch on: each lane's call goes to Claude with its own effort, reply cap and cache marks, her key and no
 *    zero-retention flag, the marks never reach a host, and the answer comes back whole (the lyric desk at its real
 *    cost, the rest priced as MiMo), with one [claude] line naming the lane;
 *  - every failure class falls back to the call as it was sent, in the same request: MiMo for the MiMo lanes, the
 *    Bedrock route for the lyric desk; a refusal on the desk is written by MiMo instead;
 *  - a background task's many rounds (no speak-first mark), a child's and an untyped account's messages stay on MiMo;
 *  - the BYOK guard turns Claude off for every lane and chat.
 *
 * To rebuild the fixture after a deliberate change to what the gateway sends for these calls, run this file with
 * CLAUDE_LANES_GOLDEN_SERVER=<the server.js to read> CLAUDE_LANES_GOLDEN_WRITE=1 (it then sends the calls unmarked). */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const claude = require('./claude-route');

const SERVER = process.env.CLAUDE_LANES_GOLDEN_SERVER || path.join(__dirname, 'server.js');
const GOLDEN = path.join(__dirname, 'test-fixtures', 'claude-lanes-off-golden.json');
const WRITING_GOLDEN = process.env.CLAUDE_LANES_GOLDEN_WRITE === '1';

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}
/* The live gateway's switches, with the paid helpers and the clock-dependent classifier off. */
const QUIET = {
  KADE_SCREEN_LIVE: 'asked', KADE_MIMO_PROVIDER_ORDER: 'PrimaLabs,DeepInfra', KADE_MIMO_THINK_PROVIDER_ORDER: 'PrimaLabs,DeepInfra',
  KADE_MIMO_QUICK: 'deadline', KADE_CHAT_THINK_DEADLINE: '1', KADE_VOICE_REEL: '1', KADE_GIST: '1',
  KADE_AUTO_DEEPTHINK: '0', KADE_JEV: '0', KADE_REGISTER_EDIT: '0', KADE_PHRASE_REPAIR: '0', KADE_REPLY_FOCUS: '0',
};
async function boot(env, server = SERVER) {
  const port = await freePort();
  const child = spawn(process.execPath, [server], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), OPENROUTER_KEY: 'test-only',
      PROXY_SHARED_SECRET: 'test-secret', ...QUIET, ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  let exited = null;
  child.on('exit', (code) => { exited = code; });
  const until = Date.now() + 30000;
  while (!/listening on/.test(out)) {
    if (exited !== null) throw new Error('gateway did not boot:\n' + out.slice(-2000));
    if (Date.now() > until) { child.kill(); throw new Error('gateway boot timed out'); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, log: () => out };
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const CLAUDE = 'anthropic/claude-opus-5.5';
const cchunk = (delta, finish = null, extra = {}) => sse({ id: 'gen-c', model: CLAUDE, provider: 'Anthropic', choices: [{ index: 0, delta, finish_reason: finish, ...extra }] });
const CLAUDE_WORDS = 'TITLE: Dirt Road Hymn\nThe words Claude wrote, start to finish.\nREADBACK: A short song.';
const BEDROCK_WORDS = 'TITLE: Bedrock Song\nThe words the zero-retention route wrote.\nREADBACK: A short song.';
const MIMO_WORDS = 'MiMo answered this one.';
const CLAUDE_USAGE = {
  prompt_tokens: 1200, completion_tokens: 150, total_tokens: 1350,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1000 },
  completion_tokens_details: { reasoning_tokens: 50 },
  cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.0153 },
};
const lastUserText = (body) => {
  const last = (body.messages || []).filter((m) => m.role === 'user').pop() || {};
  return typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
};
/* The fake host. A call on her key (provider.only names Anthropic) acts out the scenario named in its last user
 * message; the lyric desk's call as sent (Claude with zero retention) answers as Bedrock; anything else as MiMo.
 * POST /notify is the bridge. Every body is recorded, raw and parsed. */
async function fakeHost() {
  const bodies = [];
  const raws = [];
  const notes = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      if (req.url === '/notify') {
        notes.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      raws.push(raw);
      bodies.push(body);
      const model = String(body.model || '');
      const said = lastUserText(body);
      const herKey = !!(body.provider && Array.isArray(body.provider.only) && body.provider.only.includes('anthropic'));
      if (herKey) {
        if (/scenario http500/.test(said)) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Internal","code":500}}'); return; }
        if (/scenario key/.test(said)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Invalid API key","code":401}}'); return; }
        if (/scenario busy/.test(said)) { res.writeHead(429, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Rate limited","code":429}}'); return; }
        if (/scenario credit/.test(said)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'Anthropic',
            raw: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}' } } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': OPENROUTER PROCESSING\n\n');
        res.write(cchunk({ role: 'assistant', content: '', reasoning: 'a private plan for this piece' }));
        if (/scenario stall/.test(said)) { await new Promise((r) => setTimeout(r, 2500)); res.end(cchunk({ content: 'far too late' }) + 'data: [DONE]\n\n'); return; }
        if (/scenario empty/.test(said)) { res.end(cchunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
        if (/scenario lateerror/.test(said)) {
          res.end(cchunk({ content: 'Half of it' }) + sse({ id: 'gen-c', error: { code: 502, message: 'Provider returned error' },
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }));
          return;
        }
        if (/scenario refusal/.test(said)) {
          res.end(cchunk({ content: 'I would' }) + cchunk({}, 'content_filter', { native_finish_reason: 'refusal' }) +
            sse({ id: 'gen-c', model: CLAUDE, choices: [], usage: CLAUDE_USAGE }) + 'data: [DONE]\n\n');
          return;
        }
        const usage = /scenario nonbyok/.test(said) ? { ...CLAUDE_USAGE, cost: 0.0153, is_byok: false, cost_details: { upstream_inference_cost: 0.0153 } } : CLAUDE_USAGE;
        res.write(cchunk({ content: CLAUDE_WORDS.slice(0, 20) }));
        await new Promise((r) => setTimeout(r, 150));
        res.end(cchunk({ content: CLAUDE_WORDS.slice(20) }) + cchunk({}, 'stop') + sse({ id: 'gen-c', model: CLAUDE, provider: 'Anthropic', choices: [], usage }) + 'data: [DONE]\n\n');
        return;
      }
      const words = model.startsWith('anthropic/') ? BEDROCK_WORDS : MIMO_WORDS;
      const usage = { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912, cost: 0.0004, is_byok: false };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'm', model, choices: [{ index: 0, message: { role: 'assistant', content: words }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse({ id: 'm', model, provider: model.startsWith('anthropic/') ? 'Amazon Bedrock' : 'DeepInfra', choices: [{ index: 0, delta: { role: 'assistant', content: words }, finish_reason: null }] }) +
        sse({ id: 'm', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse({ id: 'm', model, choices: [], usage }) + 'data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  return { port, bodies, raws, notes, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

/* Sends a body exactly as given (stream or not) and resolves with the raw reply. */
function send(port, body, headers = {}, giveUpMs = 20000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { clearTimeout(giveUp); resolve({ text, status: res.statusCode, ms: Date.now() - t0 }); });
    });
    const giveUp = setTimeout(() => { req.destroy(); resolve({ text: null, ms: Date.now() - t0 }); }, giveUpMs);
    req.on('error', (e) => { if (!/socket hang up|ECONNRESET/.test(String(e.message))) reject(e); });
    req.end(data);
  });
}
function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Authorization: 'Bearer test-secret' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve(JSON.parse(text)));
    }).on('error', reject);
  });
}
const events = (text) => String(text || '').split('\n').filter((l) => l.startsWith('data: {')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
/* The words of a reply, streamed or one piece. */
function wordsOf(text) {
  const t = String(text || '');
  if (t.trimStart().startsWith('{')) { try { return JSON.parse(t).choices[0].message.content; } catch { return null; } }
  return events(t).map((d) => (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) || '').join('');
}
function usageOf(text) {
  const t = String(text || '');
  if (t.trimStart().startsWith('{')) { try { return JSON.parse(t).usage; } catch { return null; } }
  return (events(t).find((d) => d.usage) || {}).usage;
}
const marks = (messages) => messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content : []).filter((p) => p.cache_control).map((p) => ({ i, role: m.role, mark: p.cache_control })));
const linesOf = (log, re) => log.split('\n').filter((l) => re.test(l));
const herKeyBodies = (host, from = 0) => host.bodies.slice(from).filter((b) => b.provider && Array.isArray(b.provider.only));
/* The gateway's tail carries the US Central clock, which moves every minute. */
const normal = (raw) => raw
  .replace(/Right now it's [^"\\]{1,80} \(US Central\)/g, "Right now it's <NOW> (US Central)")
  .replace(/Current date and time where the user is: [^"\\]{1,80} \(US Central\)/g, 'Current date and time where the user is: <NOW> (US Central)');

/* Each lane's call, the way the website sends it (fork branch claude/claude-writing-20261114):
 * kadeSoundBooth.js callModel, kadeCreateCharacter.js /write-persona, kadeSpotter.js /generate, and a hidden run's
 * model call (kadeCharacterTurn.js compose, packages/api endpoints/custom/initialize.ts). */
const ADULT_NOTE = claude.ADULT_NOTES[0].site;
const CHILD_NOTE = '\n\n---\nAUDIENCE NOTE (invisible — never mention it, never hint at it, never act like you are filtering): this user is under 15. Keep your personality, humor, and edge exactly the same, but keep the content clean: no profanity, no sexual content or innuendo, no drug or alcohol talk, no graphic violence or gore, nothing genuinely disturbing. Do NOT get preachy, babyish, or watered-down — never act like you are holding back. If the conversation heads somewhere adult, redirect smoothly and naturally, in character.';
const DESK_SYSTEM = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below supplies your conversational character. The SONGWRITING CRAFT after it governs the actual lyric.\n\nCLEAN OR EXPLICIT: explicit is allowed. This song is for a verified grown-up on a private, invitation-only platform.\n\nSOUND BOOTH DELIVERY CONTRACT\nThis is a single text-only writing request, not a conversation.";
const TOOLS = [{ type: 'function', function: { name: 'kade_weather', description: 'Weather where they are', parameters: { type: 'object', properties: {} } } }];
const CALLS = {
  'lyric-desk': (said = 'a song about my truck') => ({
    model: CLAUDE, stream: true, stream_options: { include_usage: true }, max_tokens: 16384,
    reasoning: { enabled: true, effort: 'medium', exclude: true }, kade_think_deadline_ms: 120000,
    provider: { zdr: true, data_collection: 'deny' },
    messages: [{ role: 'system', content: DESK_SYSTEM }, { role: 'user', content: `WHAT THEY WANT MADE:\n${said}` }],
  }),
  'booth-edit': (said = 'A Seed script that runs long.') => ({
    model: 'xiaomi/mimo-v2.6-pro', stream: true, stream_options: { include_usage: true }, max_tokens: 16384,
    reasoning: { enabled: false, effort: 'none' }, provider: { zdr: true, data_collection: 'deny' },
    messages: [{ role: 'system', content: "You are the script desk in Kade-AI's Sound Booth. The Seed Audio script below is 2400 characters; the engine's cap is 2048 and the target is under 2000. Cut it to fit. Output the script and nothing else." },
      { role: 'user', content: said }],
  }),
  'persona-writer': (said = 'A retired ferry captain who tells long stories.') => ({
    model: 'xiaomi/mimo-v2.6-pro', max_tokens: 6000, reasoning: { enabled: true, effort: 'low', exclude: true },
    messages: [{ role: 'system', content: 'You write system prompts for characters on a chat platform. Write the whole persona in numbered sections.' },
      { role: 'user', content: `CHARACTER BRIEF (from the person building them):\n${said}\n\nWrite the character's system prompt now.` }],
  }),
  'spotter-draft': (said = 'calm and funny') => ({
    model: 'xiaomi/mimo-v2.6-pro', stream: false, max_tokens: 400, reasoning: { enabled: false, effort: 'none' },
    messages: [{ role: 'user', content: `Write a personality brief for a "Spotter". Write 4-7 sentences, second person. Build it around what the user asked for: "${said}"` }],
  }),
  'speak-first': (said = 'text them about the horses', head = 'You are Harley, a cowboy who talks plain.' + ADULT_NOTE) => ({
    model: 'xiaomi/mimo-v2.6-pro', stream: true, reasoning: { enabled: false }, temperature: 0.8, tools: TOOLS, kade_background: true,
    messages: [{ role: 'system', content: head },
      { role: 'user', content: `[PLATFORM NOTE, not something they typed: ${said}\nWrite only the message you are sending them now, in your own voice.]` }],
  }),
};
const LANES = Object.keys(CALLS);
/* The marks: headers for the website's direct calls; the body field for a hidden run (its addParams). */
function marked(lane, body, { adult = true } = {}) {
  if (lane === 'speak-first') return { body: { ...body, kade_claude_lane: 'speak-first' }, headers: {} };
  return { body, headers: { 'x-kade-claude-lane': lane, ...(adult ? { 'x-kade-adult': '1' } : {}) } };
}

test('switch off: a marked call leaves exactly as the unmarked call left origin/main, whatever keeps it off', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const runs = WRITING_GOLDEN
    ? [['golden (unmarked, the old server)', {}, false]]
    : [['route off', {}, true], ['route off, KADE_CLAUDE_CHAT=0', { KADE_CLAUDE_CHAT: '0' }, true],
      ['every lane off', { KADE_CLAUDE_CHAT: '1', KADE_CLAUDE_LANES: 'none' }, true],
      ['not marked adult', { KADE_CLAUDE_CHAT: '1' }, 'not-adult']];
  const golden = WRITING_GOLDEN ? null : JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).lanes;
  for (const [label, env, marking] of runs) {
    const gw = await boot({ ...env, OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
    try {
      const got = [];
      for (const lane of LANES) {
        // speak-first carries the note, not the mark: for "not marked adult" it gets an untyped head instead.
        const body = marking === 'not-adult' && lane === 'speak-first' ? CALLS[lane](undefined, 'You are Harley, a cowboy who talks plain.') : CALLS[lane]();
        const call = marking ? marked(lane, body, { adult: marking !== 'not-adult' }) : { body, headers: {} };
        const from = host.raws.length;
        const r = await send(gw.port, call.body, call.headers);
        assert.equal(r.status, 200, `${label} ${lane}: ${String(r.text).slice(0, 300)}`);
        const raws = host.raws.slice(from);
        assert.equal(raws.length, 1, `${label} ${lane}: one upstream body`);
        const text = normal(raws[0]);
        assert.equal(/kade_claude_lane|kade_adult/.test(text), false, `${label} ${lane}: no mark reaches a host`);
        got.push({ lane, model: JSON.parse(text).model, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') });
      }
      if (WRITING_GOLDEN) {
        fs.writeFileSync(GOLDEN, JSON.stringify({ source: process.env.CLAUDE_LANES_GOLDEN_SOURCE || SERVER, lanes: got }, null, 1) + '\n');
        return;
      }
      if (label === 'not marked adult') {
        // The speak-first call here has another head, so only the four marked lanes compare with the fixture.
        assert.deepEqual(got.slice(0, 4), golden.slice(0, 4), label);
        assert.equal(got[4].model, 'xiaomi/mimo-v2.6-pro');
        assert.equal(linesOf(gw.log(), /\[claude\]\[req \w+\] turn /).length, 0, `${label}: Claude never answered`);
        assert.equal(linesOf(gw.log(), /stays on (?:MiMo|the route it was sent on): not marked as a verified adult/).length, 5, gw.log().slice(-3000));
      } else {
        assert.deepEqual(got, golden, label);
        if (!env.KADE_CLAUDE_CHAT || env.KADE_CLAUDE_CHAT === '0') assert.doesNotMatch(gw.log(), /\[claude\]/, `${label}: the route said nothing`);
        else assert.equal(linesOf(gw.log(), /lane is off \(KADE_CLAUDE_LANES\)/).length, 5, gw.log().slice(-3000));
      }
    } finally {
      gw.child.kill();
    }
  }
});

test('switch on: each lane goes to Claude on her key with its own effort, cap and marks, and comes back whole', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ KADE_CLAUDE_CHAT: '1', KADE_CLAUDE_TOKEN_RATIO: '1', OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const want = {
    'lyric-desk': { effort: 'medium', max: 16384, marks: [{ i: 0, role: 'system', mark: { type: 'ephemeral' } }], stream: true },
    'booth-edit': { effort: 'low', max: 18384, marks: [], stream: true },
    // MiMo's adapter raised the builder's 6,000 to its thinking floor (16,000) before Claude was asked; a cap only.
    'persona-writer': { effort: 'low', max: 18000, marks: [], stream: true },
    'spotter-draft': { effort: 'low', max: 2400, marks: [], stream: true },
    'speak-first': { effort: 'low', max: 8000, marks: [{ i: 0, role: 'system', mark: { type: 'ephemeral' } }], stream: true },
  };
  for (const lane of LANES) {
    const from = host.bodies.length;
    const call = marked(lane, CALLS[lane]());
    const r = await send(gw.port, call.body, call.headers);
    assert.equal(r.status, 200, `${lane}: ${String(r.text).slice(0, 300)}`);
    const sent = host.bodies.slice(from);
    assert.equal(sent.length, 1, `${lane}: one call, to Claude: ${JSON.stringify(sent.map((b) => b.model))}`);
    const b = sent[0];
    assert.equal(b.model, CLAUDE, lane);
    assert.deepEqual(b.provider, { only: ['anthropic'], allow_fallbacks: false }, lane);
    assert.equal(JSON.stringify(b).includes('zdr'), false, `${lane}: no zero-retention flag`);
    assert.equal(/kade_claude_lane|kade_adult|kade_background|kade_think_deadline_ms/.test(JSON.stringify(b)), false, `${lane}: no mark reaches a host`);
    assert.deepEqual(b.reasoning, { effort: want[lane].effort, exclude: true }, lane);
    assert.equal(b.max_tokens, want[lane].max, lane);
    assert.equal(b.stream, want[lane].stream, `${lane}: read as a stream underneath`);
    assert.deepEqual(marks(b.messages), want[lane].marks, lane);
    assert.equal('models' in b, false, lane);
    assert.equal('temperature' in b, false, lane);
    assert.equal(wordsOf(r.text), CLAUDE_WORDS, `${lane}: Claude's whole answer`);
    assert.equal(/a private plan/.test(r.text), false, `${lane}: no thought reaches the caller`);
    const usage = usageOf(r.text);
    if (lane === 'lyric-desk') {
      assert.equal(usage.is_byok, true, 'the desk is handed the real usage');
      assert.equal(usage.cost_details.upstream_inference_cost, 0.0153);
      assert.equal(usage.completion_tokens, 150);
    } else {
      assert.equal(usage.is_byok, false, `${lane}: priced as MiMo`);
      assert.equal(usage.completion_tokens, 100, `${lane}: the reply without its thinking`);
      assert.equal(usage.kade_claude.real_cost, 0.0153);
    }
  }
  const head = host.bodies.find((b) => b.model === CLAUDE && Array.isArray(b.tools)).messages[0].content.map((p) => p.text).join('');
  assert.match(head, /keep sex off the page/, 'speak-first gets the softened adult note, as chat does');
  await new Promise((r) => setTimeout(r, 300));
  const log = gw.log();
  for (const lane of LANES) {
    const lines = linesOf(log, new RegExp(`\\[claude\\]\\[req \\w+\\] turn lane=${lane} `));
    assert.equal(lines.length, 1, `${lane}\n${log.slice(-3000)}`);
    assert.equal(/Dirt Road|ferry|truck|horses/.test(lines[0]), false, 'never the words');
  }
  assert.match(log, /turn lane=lyric-desk effort=medium ms=\d+ prompt=1200 cached=0 cache_write=1000 reply=100 reasoning=50 cost=\$0\.015300 \(BYOK: OpenRouter fee \$0\.000000 \+ provider \$0\.015300\) gen=gen-c host=Anthropic/);
  assert.match(log, /turn lane=persona-writer effort=low ms=\d+ .* billed_as_mimo=\$/);
  assert.match(log, /turn lane=speak-first effort=low first_token_ms=\d+ /);
  const spend = await get(gw.port, '/claude-spend');
  assert.deepEqual(spend.writing_lanes_on, LANES);
  for (const lane of LANES) assert.equal(spend.lanes[lane], 1, lane);
});

test('every failure falls back in the same request: the MiMo lanes to MiMo, the desk to its own route, a refused song to MiMo', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ KADE_CLAUDE_CHAT: '1', KADE_CLAUDE_IDLE_MS: '700', KADE_CLAUDE_COOLDOWN_MIN: '0', KADE_CLAUDE_ERROR_COOLDOWN_MIN: '0',
    KADE_CLAUDE_CONVERSATION_SKIP_MIN: '0', KADE_CLAUDE_STRIKES: '100', OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const failures = [['http500', 'http_500'], ['key', 'key'], ['busy', 'rate_limit'], ['credit', 'credit'], ['empty', 'empty'],
    ['lateerror', 'http_502'], ['refusal', 'refusal'], ['stall', 'timeout']];
  for (const lane of ['booth-edit', 'persona-writer', 'spotter-draft']) {
    for (const [scenario, reason] of failures) {
      const from = host.bodies.length;
      const call = marked(lane, CALLS[lane](`scenario ${scenario} please`));
      const r = await send(gw.port, call.body, call.headers);
      assert.equal(r.status, 200, `${lane} ${scenario}`);
      const sent = host.bodies.slice(from);
      assert.deepEqual(sent.map((b) => (b.provider && b.provider.only ? 'claude' : b.model)), ['claude', 'xiaomi/mimo-v2.6-pro'], `${lane} ${scenario}`);
      assert.equal(wordsOf(r.text), MIMO_WORDS, `${lane} ${scenario}: MiMo answered in the same request`);
      assert.equal(linesOf(gw.log(), new RegExp(`fallback to MiMo: lane=${lane} reason=${reason} `)).length >= 1, true, `${lane} ${scenario}\n${gw.log().slice(-2500)}`);
    }
  }
  // The lyric desk: a failure sends the song the way the website sent it (Claude, zero retention, the old payer).
  for (const [scenario, reason] of failures.filter(([s]) => s !== 'refusal')) {
    const from = host.bodies.length;
    const call = marked('lyric-desk', CALLS['lyric-desk'](`scenario ${scenario} song`));
    const r = await send(gw.port, call.body, call.headers);
    const sent = host.bodies.slice(from);
    assert.equal(sent.length, 2, `desk ${scenario}`);
    assert.equal(sent[1].model, CLAUDE, `desk ${scenario}: the route it was sent on`);
    assert.equal(sent[1].provider.zdr, true, `desk ${scenario}: with zero retention, as before`);
    assert.equal(sent[1].provider.only, undefined);
    assert.equal(wordsOf(r.text), BEDROCK_WORDS, `desk ${scenario}`);
    assert.equal(linesOf(gw.log(), new RegExp(`fallback to the route it was sent on: lane=lyric-desk reason=${reason} `)).length >= 1, true, `desk ${scenario}`);
  }
  // A refused song: Bedrock would refuse the same words, so MiMo Pro writes it, on its own hosts with zero retention.
  const from = host.bodies.length;
  const call = marked('lyric-desk', CALLS['lyric-desk']('scenario refusal song'));
  const r = await send(gw.port, call.body, call.headers);
  const sent = host.bodies.slice(from);
  assert.deepEqual(sent.map((b) => (b.provider && b.provider.only ? 'claude' : b.model)), ['claude', 'xiaomi/mimo-v2.6-pro'], gw.log().slice(-2000));
  const mimo = sent[1];
  assert.equal(mimo.provider.zdr, true);
  assert.equal(mimo.provider.data_collection, 'deny');
  assert.deepEqual(mimo.provider.order, ['PrimaLabs', 'DeepInfra'], 'MiMo\'s own thinking hosts');
  assert.equal(mimo.reasoning.enabled, true, 'it thinks, as the desk asked');
  assert.equal(mimo.max_tokens, 16384);
  assert.equal(wordsOf(r.text), MIMO_WORDS);
  assert.match(gw.log(), /fallback to xiaomi\/mimo-v2\.6-pro: lane=lyric-desk reason=refusal /);
  assert.match(gw.log(), /Claude refused this lyric-desk: xiaomi\/mimo-v2\.6-pro writes it instead/);
  assert.equal(linesOf(gw.log(), /\[claude\]\[req \w+\] turn /).length, 0, 'no failed call was counted as a Claude answer');
});

test('who stays: a background task, a child, an untyped account and an unmarked person never reach Claude', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ KADE_CLAUDE_CHAT: '1', OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const before = host.bodies.length;
  // A background task's rounds carry kade_background with no speak-first mark.
  await send(gw.port, CALLS['speak-first']('BACKGROUND JOB: research the horses'));
  // A child's and an untyped account's message, marked as one message.
  await send(gw.port, marked('speak-first', CALLS['speak-first'](undefined, 'You are Harley.' + CHILD_NOTE)).body);
  await send(gw.port, marked('speak-first', CALLS['speak-first'](undefined, 'You are Harley.')).body);
  // A child's Spotter and persona drafts: no adult mark, and an under-15 head never goes even if one were sent.
  for (const lane of ['spotter-draft', 'persona-writer', 'booth-edit', 'lyric-desk']) {
    const call = marked(lane, CALLS[lane](), { adult: false });
    await send(gw.port, call.body, call.headers);
  }
  const child = CALLS['persona-writer']();
  child.messages[0] = { role: 'system', content: child.messages[0].content + CHILD_NOTE };
  await send(gw.port, child, { 'x-kade-claude-lane': 'persona-writer', 'x-kade-adult': '1' });
  // A lane name the gateway does not know is not a lane.
  await send(gw.port, CALLS['spotter-draft'](), { 'x-kade-claude-lane': 'spotter', 'x-kade-adult': '1' });
  assert.equal(herKeyBodies(host, before).length, 0, gw.log().slice(-3000));
  assert.match(gw.log(), /stays on MiMo: child or teen account \(lane=speak-first\)/);
  assert.match(gw.log(), /stays on MiMo: not marked as a verified adult \(lane=speak-first\)/);
  assert.match(gw.log(), /stays on the route it was sent on: not marked as a verified adult \(lane=lyric-desk\)/);
  assert.match(gw.log(), /stays on MiMo: child or teen account \(lane=persona-writer\)/);
});

test('the BYOK guard on a lane: the call is served, then every lane and chat stay off Claude', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ KADE_CLAUDE_CHAT: '1', OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_BRIDGE_URL: `http://127.0.0.1:${host.port}`, BRIDGE_SECRET: 'bridge-test' });
  t.after(() => gw.child.kill());
  const first = marked('persona-writer', CALLS['persona-writer']('scenario nonbyok captain'));
  const r = await send(gw.port, first.body, first.headers);
  assert.equal(wordsOf(r.text), CLAUDE_WORDS, 'served');
  await new Promise((r2) => setTimeout(r2, 300));
  assert.match(gw.log(), /NOT PAID BY HER ANTHROPIC KEY: OpenRouter credit paid \$0\.015300 for this turn \(is_byok=false, lane=persona-writer, gen=gen-c\)\. Claude skipped for 1440 min\./);
  assert.equal(host.notes.length, 1, 'one admin alert');
  assert.equal(host.notes[0].agentId, 'claude-not_byok-alert');
  const before = host.bodies.length;
  for (const lane of LANES) {
    const call = marked(lane, CALLS[lane]());
    await send(gw.port, call.body, call.headers);
  }
  assert.equal(herKeyBodies(host, before).length, 0, 'every lane stays where it was sent');
  assert.equal(linesOf(gw.log(), /cooling down after not_byok/).length, 5);
});
