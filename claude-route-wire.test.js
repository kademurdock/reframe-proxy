'use strict';
/* Nov 13 2026: the Claude route on the wire (claude-route.js, KADE_CLAUDE_CHAT=1). Boots the real gateway
 * against a fake host on 127.0.0.1 and reads what the host was sent, what a client got and what the log says.
 * Nothing paid.
 *  - a verified adult's MiMo Pro character turn goes to Claude: Anthropic only, no zero-retention flag, low
 *    effort with the thinking kept out, the website's adult note softened, cache marks on the head and the
 *    history; the reply, voice directions and all, reaches the client with MiMo-equivalent usage; one
 *    [claude] line; the editors still run after it;
 *  - the fast start (kade_live) and a phone call stream Claude's words as they come;
 *  - the one-piece route (stream:false) is answered by Claude too;
 *  - background runs, titles, checkpoints, JSON lanes, other models, child accounts, untyped accounts and the
 *    Game Parlor's unmarked table talk never see Claude (the Nov 13 review's blocker);
 *  - every failure before the first word is answered by MiMo in the same turn, with one fallback line;
 *  - a refusal after the first word is re-asked of MiMo, never served as the reply;
 *  - a credit-balance answer keeps everyone on MiMo for the cooldown, a refusal only that conversation, and
 *    two stalls inside ten minutes everyone for two minutes; a short cooldown runs out and Claude is asked
 *    again; GET /claude-spend adds it up;
 *  - the BYOK guard: a turn paid from OpenRouter credit turns Claude off and sends the admin alert. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}
async function boot(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), OPENROUTER_KEY: 'test-only',
      PROXY_SHARED_SECRET: 'test-secret', KADE_AUTO_DEEPTHINK: '0', KADE_JEV: '0', KADE_CLAUDE_CHAT: '1',
      KADE_CLAUDE_FIRST_TOKEN_MS: '700', KADE_SCREEN_LIVE: 'asked', KADE_CLAUDE_TOKEN_RATIO: '1',
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...env },
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
const OPENING = '%%%warm and easy%%% Howdy, partner.';
const REST = ' The horses are fine this morning. Daisy kicked her water bucket over again, so I spent a while ' +
  'hauling a fresh one up from the creek, and the bay colt finally let me pick up his back feet without a fuss. ' +
  'Weather is holding, the fence along the north pasture still needs a post or two, and I figure that is a job ' +
  'for tomorrow when the ground has dried out some.';
const MIMO_WORDS = 'MiMo answered this one.';
/* Her key in OpenRouter (BYOK): OpenRouter's own fee is 0 inside the free allowance, Anthropic's charge is upstream. */
const CLAUDE_USAGE = {
  prompt_tokens: 1200, completion_tokens: 150, total_tokens: 1350,
  prompt_tokens_details: { cached_tokens: 1000, cache_write_tokens: 0 },
  completion_tokens_details: { reasoning_tokens: 50 },
  cost: 0, is_byok: true, cost_details: { upstream_inference_cost: 0.00174 },
};
const SECRET_WORDS = 'my cousin Theodora lost her ring at the Springfield fair';

/* The fake host. A Claude body acts out the scenario named in the person's last message; anything else
 * answers as MiMo (or as an editor) would. POST /notify is the bridge. Every body is recorded with the time
 * it arrived. */
async function fakeHost() {
  const bodies = [];
  const notes = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      if (req.url === '/notify') {
        notes.push(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      bodies.push({ at: Date.now(), body });
      const model = String(body.model || '');
      const last = String(((body.messages || []).filter((m) => m.role === 'user').pop() || {}).content || '');
      const said = typeof last === 'string' ? last : JSON.stringify(last);
      if (model.startsWith('anthropic/')) {
        if (/scenario http500/.test(said)) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Internal","code":500}}'); return; }
        if (/scenario credit/.test(said)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 400, message: 'Provider returned error', metadata: { provider_name: 'Anthropic',
            raw: '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}' } } }));
          return;
        }
        if (/scenario badmodel/.test(said)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 400, message: `${model} is not a valid model ID` } })); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': OPENROUTER PROCESSING\n\n');
        res.write(cchunk({ role: 'assistant', content: '' }));
        if (/scenario stall/.test(said)) { await new Promise((r) => setTimeout(r, 3000)); res.end(cchunk({ content: 'far too late' }) + 'data: [DONE]\n\n'); return; }
        if (/scenario empty/.test(said)) { res.end(cchunk({}, 'stop') + 'data: [DONE]\n\n'); return; }
        if (/scenario refusalwords/.test(said)) {
          res.end(cchunk({ content: 'I would' }) + cchunk({}, 'content_filter', { native_finish_reason: 'refusal' }) +
            sse({ id: 'gen-c', model: CLAUDE, choices: [], usage: CLAUDE_USAGE }) + 'data: [DONE]\n\n');
          return;
        }
        if (/scenario refusal/.test(said)) {
          res.end(cchunk({}, 'content_filter', { native_finish_reason: 'refusal' }) + sse({ id: 'gen-c', model: CLAUDE, choices: [], usage: CLAUDE_USAGE }) + 'data: [DONE]\n\n');
          return;
        }
        if (/scenario errorevent/.test(said)) {
          res.end(sse({ id: 'gen-c', error: { code: 502, message: 'Provider returned error', metadata: { error_type: 'provider_error' } },
            choices: [{ index: 0, delta: { content: '' }, finish_reason: 'error' }] }));
          return;
        }
        res.write(cchunk({ content: '', reasoning: 'thinking about horses privately', reasoning_details: [{ type: 'reasoning.text', text: 'more private thought' }] }));
        const usage = /scenario nonbyok/.test(said) ? { ...CLAUDE_USAGE, cost: 0.00174, is_byok: false, cost_details: { upstream_inference_cost: 0.00174 } } : CLAUDE_USAGE;
        if (/scenario tool/.test(said)) {
          res.end(cchunk({ tool_calls: [{ index: 0, id: 'call_w', type: 'function', function: { name: 'kade_weather', arguments: '{}' } }] }) +
            cchunk({}, 'tool_calls') + sse({ id: 'gen-c', model: CLAUDE, choices: [], usage }) + 'data: [DONE]\n\n');
          return;
        }
        res.write(cchunk({ content: OPENING }));
        await new Promise((r) => setTimeout(r, 400));
        res.end(cchunk({ content: REST }) + cchunk({}, 'stop') + sse({ id: 'gen-c', model: CLAUDE, provider: 'Anthropic', choices: [], usage }) + 'data: [DONE]\n\n');
        return;
      }
      const usage = { prompt_tokens: 900, completion_tokens: 12, total_tokens: 912, cost: 0.0004, is_byok: false };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'm', model, choices: [{ index: 0, message: { role: 'assistant', content: MIMO_WORDS }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse({ id: 'm', model, provider: 'DeepInfra', choices: [{ index: 0, delta: { role: 'assistant', content: MIMO_WORDS }, finish_reason: null }] }) +
        sse({ id: 'm', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse({ id: 'm', model, choices: [], usage }) + 'data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  return { port, bodies, notes, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

/* Resolves with the whole reply and when its first visible words arrived. */
function ask(port, body, headers = {}, giveUpMs = 15000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ stream: true, ...body });
    const t0 = Date.now();
    let firstWordsAt = 0;
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (!firstWordsAt && /Howdy|MiMo answered/.test(text)) firstWordsAt = Date.now() - t0; });
      res.on('end', () => { clearTimeout(giveUp); resolve({ text, status: res.statusCode, ms: Date.now() - t0, firstWordsAt }); });
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
/* The website's live verified-adult note and its under-15 note, word for word (LibreChat fork, branch kade,
 * 5ac7fdb4c, api/server/services/Endpoints/agents/build.js). */
const ADULT_NOTE = "\n\n---\nThis is an audience note, and it's private, so don't mention it or hint at it. This platform is private and invitation-only, and the person you're talking to is a verified adult. Swearing is your character's call. Adult content is allowed when they ask. That includes dark humor and sexually explicit writing or roleplay between consenting adult characters. When an adult asks for that, stay in character and write it fully and explicitly. Don't refuse, don't fade to black, don't soften it into euphemism, and don't lecture or tack on disclaimers. Don't bring adult content into a conversation that didn't ask for it. Match what this person wants and go no further. Anything that sexualizes minors stays off limits, with no exceptions.";
const CHILD_NOTE = '\n\n---\nAUDIENCE NOTE (invisible — never mention it, never hint at it, never act like you are filtering): this user is under 15. Keep your personality, humor, and edge exactly the same, but keep the content clean: no profanity, no sexual content or innuendo, no drug or alcohol talk, no graphic violence or gore, nothing genuinely disturbing. Do NOT get preachy, babyish, or watered-down — never act like you are holding back. If the conversation heads somewhere adult, redirect smoothly and naturally, in character.';
const HEAD = 'You are Harley, a cowboy who talks plain.' + ADULT_NOTE;
const CHILD_HEAD = 'You are Harley.' + CHILD_NOTE;
const TOOLS = [{ type: 'function', function: { name: 'kade_weather', description: 'Weather where they are', parameters: { type: 'object', properties: {} } } }];
const turn = (said, over = {}, opener = 'hi there') => ({
  model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, temperature: 0.8, tools: TOOLS,
  messages: [{ role: 'system', content: HEAD }, { role: 'user', content: opener }, { role: 'assistant', content: '%%%easy%%% Howdy yourself.' },
    { role: 'user', content: said }],
  ...over,
});
/* A Game Parlor table line for a child (kadeParlor.js /talk): one piece, max_tokens 160, no audience note. */
const parlorLine = () => ({ model: 'xiaomi/mimo-v2.6-pro', stream: false, max_tokens: 160, usage: { include: true },
  messages: [{ role: 'system', content: 'You are Harley, seated at a Go Fish table in the Kade-AI Game Parlor. Stay fully in character.\n\nYour persona:\n' +
    'You are Harley, a cowboy who talks plain.\n\nThe player just said something to you at the table. Reply with ONE short spoken line.' },
  { role: 'user', content: 'Recent table log:\n\nPlayer says: got any sevens?' }] });
const events = (text) => text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const words = (text) => events(text).map((d) => (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) || '').join('');
const usageOf = (text) => (events(text).find((d) => d.usage) || {}).usage;
const claudeBodies = (host, from = 0) => host.bodies.slice(from).filter((b) => String(b.body.model).startsWith('anthropic/'));
const proBodies = (host, from = 0) => host.bodies.slice(from).filter((b) => b.body.model === 'xiaomi/mimo-v2.6-pro');
const marks = (messages) => messages.flatMap((m, i) => (Array.isArray(m.content) ? m.content : []).filter((p) => p.cache_control).map((p) => ({ i, role: m.role, mark: p.cache_control })));
const linesOf = (log, re) => log.split('\n').filter((l) => re.test(l));
const headText = (b) => (typeof b.messages[0].content === 'string' ? b.messages[0].content : b.messages[0].content.map((p) => p.text).join(''));

test('a typed character turn goes to Claude and comes back whole, priced as MiMo; the editors still run', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());

  const r = await ask(gw.port, turn(`tell me about the horses, ${SECRET_WORDS}`));
  assert.equal(r.status, 200);
  const sent = claudeBodies(host);
  assert.equal(sent.length, 1, 'one Claude call');
  const b = sent[0].body;
  assert.equal(b.model, CLAUDE);
  assert.deepEqual(b.provider, { only: ['anthropic'], allow_fallbacks: false });
  assert.deepEqual(b.reasoning, { effort: 'low', exclude: true });
  assert.equal(b.max_tokens, 8000, 'the website set no cap');
  assert.equal('temperature' in b, false, 'Opus 5.5 takes no sampler');
  assert.equal('models' in b, false, 'no MiMo Flash backup on this route');
  assert.equal(JSON.stringify(b).includes('zdr'), false);
  assert.deepEqual(b.tools, TOOLS);
  assert.equal(b.stream, true);
  assert.deepEqual(marks(b.messages), [
    { i: 0, role: 'system', mark: { type: 'ephemeral', ttl: '1h' } },
    { i: 2, role: 'assistant', mark: { type: 'ephemeral', ttl: '1h' } },
  ], 'the head and the history are marked; the person\'s turn and the gateway tail are not');
  const head = headText(b);
  assert.ok(head.startsWith('You are Harley, a cowboy who talks plain.\n\n---\n'), 'the persona rides as it was');
  assert.match(head, /the person you're talking to is a verified adult/);
  assert.match(head, /keep sex off the page/, 'Claude gets the softened adult note');
  assert.equal(/write it fully and explicitly|Don't refuse/.test(JSON.stringify(b)), false, 'nothing asks Claude for explicit writing');
  assert.equal(b.messages.at(-1).role, 'system', 'the gateway tail still rides last');
  assert.ok(b.messages.at(-1).content.includes('%%%...%%%'), 'with the voice direction note');
  assert.equal(proBodies(host).length, 0, 'MiMo Pro was never asked');

  assert.equal(words(r.text), OPENING + REST, 'the whole reply, voice direction included');
  assert.equal(/thinking about horses|more private thought/.test(r.text), false, 'no thought reaches the client');
  const usage = usageOf(r.text);
  assert.equal(usage.prompt_tokens, 1200);
  assert.equal(usage.completion_tokens, 100, 'the reply without its thinking');
  assert.equal(usage.prompt_tokens_details.cached_tokens, 1000);
  assert.equal(usage.cost, Math.round(200 * 0.435 + 1000 * 0.0036 + 100 * 0.87) / 1e6, 'the MiMo price');
  assert.equal(usage.kade_claude.real_cost, 0.00174, 'the real cost rides beside it');
  assert.equal(usage.kade_claude.is_byok, true);
  assert.equal(usage.kade_claude.reasoning_tokens, 50);

  await new Promise((r2) => setTimeout(r2, 200));
  const log = gw.log();
  const lines = linesOf(log, /\[claude\]\[req \w+\] turn /);
  assert.equal(lines.length, 1, log.slice(-3000));
  assert.match(lines[0], /turn lane=buffered effort=low first_token_ms=\d+ prompt=1200 cached=1000 cache_write=0 reply=100 reasoning=50 cost=\$0\.001740 \(BYOK: OpenRouter fee \$0\.000000 \+ provider \$0\.001740\) billed_as_mimo=\$0\.000178 gen=gen-c host=Anthropic/);
  assert.equal(log.includes('Theodora'), false, 'no chat words in the log');
  assert.doesNotMatch(log, /NOT PAID/, 'her key paid');
  const editor = host.bodies.filter((x) => x.body.model === 'xiaomi/mimo-v2.6-flash' && x.at >= sent[0].at);
  assert.ok(editor.length >= 1, 'the register editor still reads the reply on the buffered lane');
  assert.match(log, /\[register-edit\]/);
});

test('the fast start (kade_live) and a phone call stream Claude\'s words as they come; editors stay out', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());

  const live = await ask(gw.port, { ...turn('what are the horses up to'), kade_live: true });
  assert.equal(claudeBodies(host).length, 1);
  assert.equal('kade_live' in claudeBodies(host)[0].body, false, 'the flag never reaches a host');
  assert.ok(live.firstWordsAt > 0 && live.firstWordsAt < live.ms - 250, `first words at ${live.firstWordsAt} ms, whole reply at ${live.ms} ms`);
  assert.equal(words(live.text), OPENING + REST);
  assert.equal(/private/.test(live.text), false);
  assert.match(gw.log(), /SCREEN turn -> live content passthrough/);
  assert.match(gw.log(), /turn lane=screen-live effort=low/);
  assert.equal(host.bodies.filter((x) => x.body.model === 'xiaomi/mimo-v2.6-flash').length, 0, 'no editor on a live turn');

  const call = await ask(gw.port, turn('how are the horses [PHONE CALL from Kade. Speak naturally.]'));
  assert.equal(claudeBodies(host).length, 2);
  assert.ok(call.firstWordsAt > 0 && call.firstWordsAt < call.ms - 250, 'a call hears the first words early');
  assert.match(gw.log(), /turn lane=phone effort=low/);
  assert.equal(proBodies(host).length, 0);
});

test('the one-piece route (stream:false) is answered by Claude, handed back as one completion', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const r = await ask(gw.port, { ...turn('a room turn about horses'), stream: false, max_tokens: 600 });
  const sent = claudeBodies(host);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.stream, true, 'read as a stream underneath, so the first-word limit holds');
  assert.equal(sent[0].body.max_tokens, 2600, 'the caller\'s 600 plus room to think, not 8000');
  assert.deepEqual(marks(sent[0].body.messages).map((m) => m.mark), [{ type: 'ephemeral', ttl: '1h' }, { type: 'ephemeral' }],
    'a one-piece history is marked for five minutes');
  const json = JSON.parse(r.text);
  assert.equal(json.object, 'chat.completion');
  assert.equal(json.choices[0].message.content.startsWith(OPENING), true);
  assert.equal(json.usage.completion_tokens, 100);
  assert.equal(json.usage.kade_claude.real_cost, 0.00174);
  assert.match(gw.log(), /turn lane=one-piece/);
  assert.equal(proBodies(host).length, 0);
});

test('background runs, titles, checkpoints, JSON, other models, children, untyped accounts and the Parlor never see Claude', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());

  let pro = 0;
  const send = async (body, headers) => { if (body.model === 'xiaomi/mimo-v2.6-pro') pro += 1; return ask(gw.port, body, headers); };
  await send(turn('tell me about the horses'), { 'x-kade-background': '1' });
  await send({ ...turn('tell me about the horses'), kade_background: true });
  await send({ model: 'xiaomi/mimo-v2.6-pro', stream: false, messages: [{ role: 'user', content: 'Name this conversation: horses and fences' }] });
  await send({ ...turn('give me the horses as JSON'), response_format: { type: 'json_object' } });
  await send({ ...turn('tell me about the horses'), model: 'xiaomi/mimo-v2.6-flash' });
  await send({ ...turn('tell me about the horses'), model: 'deepseek/deepseek-v4.1-flash' });
  const child = turn('tell me about the horses');
  child.messages[0] = { role: 'system', content: CHILD_HEAD };
  await send(child);
  // The Nov 13 review's blocker, reproduced: a child's Game Parlor line carries no note, and used to reach Claude.
  const parlor = await send(parlorLine());
  assert.equal(JSON.parse(parlor.text).choices[0].message.content, MIMO_WORDS);
  // An account nobody has typed yet.
  const untyped = turn('tell me about the horses');
  untyped.messages[0] = { role: 'system', content: 'You are Harley, a cowboy who talks plain.' };
  await send(untyped);
  // A persona that only says "verified adults" is not the website's note.
  const persona = turn('tell me about the horses');
  persona.messages[0] = { role: 'system', content: 'You are Rex. This character is for verified adults only.' };
  await send(persona);
  // The checkpoint writer with the persona head (the Part 91 shape): on the wire it ends on the gateway's date note.
  await send({ model: 'xiaomi/mimo-v2.6-pro', stream: true, reasoning: { enabled: false },
    messages: [{ role: 'system', content: HEAD }, { role: 'user', content: 'Hold on — before you continue, write me a checkpoint of everything so far.' }] });
  assert.match(gw.log(), /\[compaction\] checkpoint prompt detected/);

  assert.equal(claudeBodies(host).length, 0, host.bodies.map((x) => x.body.model).join(','));
  assert.equal(proBodies(host).length, pro, 'one MiMo Pro call for each of those turns');
  assert.equal(proBodies(host).filter((x) => x.body.provider && x.body.provider.zdr === true).length, pro, 'every MiMo Pro turn kept the zero-retention rule');
  assert.match(gw.log(), /\[claude\]\[req \w+\] stays on MiMo: child or teen account \(lane=buffered\)/);
  assert.match(gw.log(), /\[claude\]\[req \w+\] stays on MiMo: not marked as a verified adult \(lane=one-piece\)/);
  assert.equal(linesOf(gw.log(), /stays on MiMo: not marked as a verified adult \(lane=buffered\)/).length, 2, 'the untyped account and the persona');
  const spend = await get(gw.port, '/claude-spend');
  assert.equal(spend.adults_only, true);
  assert.equal(spend.stayed_on_mimo['not marked as a verified adult'], 3);
  assert.equal(spend.stayed_on_mimo['child or teen account'], 1);

  const think = await ask(gw.port, turn('think this through', { reasoning: { enabled: true, effort: 'high' } }));
  assert.equal(claudeBodies(host).length, 1, 'a Deep turn is a character turn too');
  assert.deepEqual(claudeBodies(host)[0].body.reasoning, { effort: 'medium', exclude: true }, 'capped at KADE_CLAUDE_MAX_EFFORT');
  assert.equal(words(think.text), OPENING + REST);
});

test('KADE_CLAUDE_ADULTS_ONLY=0 lets an unmarked table line go, at its own small cap; a child still never does', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_CLAUDE_ADULTS_ONLY: '0' });
  t.after(() => gw.child.kill());
  const r = await ask(gw.port, parlorLine());
  const sent = claudeBodies(host);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.max_tokens, 2160, 'the Parlor\'s 160 plus 2,000 to think, not 8,000');
  assert.ok(JSON.parse(r.text).choices[0].message.content.startsWith(OPENING));
  const child = turn('tell me about the horses');
  child.messages[0] = { role: 'system', content: CHILD_HEAD };
  await ask(gw.port, child);
  assert.equal(claudeBodies(host).length, 1);
});

test('every failure before the first word is answered by MiMo in the same turn, one line each', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  // Nothing held between the cases: no cooldowns, no conversation holds, no strikes.
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_CLAUDE_ERROR_COOLDOWN_MIN: '0', KADE_CLAUDE_COOLDOWN_MIN: '0',
    KADE_CLAUDE_CONVERSATION_SKIP_MIN: '0', KADE_CLAUDE_STRIKES: '100' });
  t.after(() => gw.child.kill());

  const cases = [['http500', 'http_500'], ['badmodel', 'bad_model'], ['stall', 'timeout'], ['empty', 'empty'], ['errorevent', 'http_502'], ['refusal', 'refusal']];
  for (const [scenario, reason] of cases) {
    const from = host.bodies.length;
    for (const live of [false, true]) {
      const before = host.bodies.length;
      const r = await ask(gw.port, { ...turn(`horses please scenario ${scenario}`), ...(live ? { kade_live: true } : {}) });
      assert.equal(r.status, 200, `${scenario} live=${live}`);
      assert.equal(words(r.text), MIMO_WORDS, `${scenario} live=${live}: MiMo's answer, nothing of Claude's`);
      const after = host.bodies.slice(before);
      assert.equal(after.filter((x) => String(x.body.model).startsWith('anthropic/')).length, 1, scenario);
      const pro = after.filter((x) => x.body.model === 'xiaomi/mimo-v2.6-pro');
      assert.equal(pro.length, 1, `${scenario}: MiMo asked once`);
      assert.equal(pro[0].body.provider.zdr, true, 'the MiMo turn is the normal MiMo route');
      assert.ok(headText(pro[0].body).includes(ADULT_NOTE), 'MiMo gets the website\'s own note, untouched');
      assert.ok(pro[0].at >= after[0].at, 'MiMo after Claude');
    }
    assert.equal(linesOf(gw.log(), new RegExp(`fallback to MiMo: lane=(?:buffered|screen-live) reason=${reason} `)).length, 2, `${scenario}\n${gw.log().slice(-2500)}`);
    assert.ok(host.bodies.length > from);
  }
  assert.match(gw.log(), /fallback to MiMo: lane=buffered reason=timeout after \d+ms gen=gen-c cost=not reported -- strike 1 of 100/);
  assert.match(gw.log(), /fallback to MiMo: lane=buffered reason=refusal after \d+ms gen=gen-c cost=\$0\.001740 -- Claude not skipped/);
  const spend = await get(gw.port, '/claude-spend');
  assert.equal(spend.paid_fallbacks, 8, 'stall, empty, error event and refusal, twice each, were accepted by Claude');
  assert.equal(spend.fallback_cost_usd, 0.00348, 'the two refusals reported what they cost');
  assert.equal(spend.turns, 0);
});

test('a refusal after Claude\'s first words is re-asked of MiMo, never served as the reply', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const r = await ask(gw.port, turn('horses please scenario refusalwords'));
  assert.equal(words(r.text), MIMO_WORDS, 'the person gets MiMo\'s whole reply');
  assert.equal(r.text.includes('I would'), false, 'and none of the refusal');
  assert.match(gw.log(), /stream died mid-generation \(finish=error\)/);
  assert.match(gw.log(), /turn lane=buffered effort=low first_token_ms=\d+ refused=after words prompt=1200 /);
  const before = host.bodies.length;
  await ask(gw.port, turn('and the fence?'));
  assert.equal(claudeBodies(host, before).length, 0, 'that conversation stays on MiMo for a while');
  assert.match(gw.log(), /stays on MiMo: Claude failed on this conversation \(refusal\)/);
});

test('a credit answer cools everyone; a refusal holds one conversation; two stalls cool everyone for two minutes', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());

  // A refusal: only that conversation stays on MiMo.
  await ask(gw.port, turn('horses please scenario refusal'));
  assert.match(gw.log(), /fallback to MiMo: lane=buffered reason=refusal after \d+ms gen=gen-c cost=\$0\.001740 -- Claude skipped for this conversation for 30 min/);
  let before = host.bodies.length;
  const same = await ask(gw.port, turn('tell me about the horses'));
  assert.equal(words(same.text), MIMO_WORDS);
  assert.equal(claudeBodies(host, before).length, 0, 'the same conversation stays on MiMo');
  before = host.bodies.length;
  const other = await ask(gw.port, turn('tell me about the horses', {}, 'evening, Harley'));
  assert.equal(claudeBodies(host, before).length, 1, 'another conversation still goes to Claude');
  assert.equal(words(other.text), OPENING + REST);

  // Two stalls in two conversations: one strike each, and the second cools everyone.
  await ask(gw.port, turn('horses please scenario stall', {}, 'morning one'));
  assert.match(gw.log(), /reason=timeout after \d+ms gen=gen-c cost=not reported -- strike 1 of 2/);
  before = host.bodies.length;
  await ask(gw.port, turn('tell me about the horses', {}, 'morning two'));
  assert.equal(claudeBodies(host, before).length, 1, 'one stall cools nobody');
  await ask(gw.port, turn('horses please scenario stall', {}, 'morning three'));
  assert.match(gw.log(), /reason=timeout after \d+ms gen=gen-c cost=not reported -- strike 2 of 2: Claude skipped for 2 min/);
  before = host.bodies.length;
  await ask(gw.port, turn('tell me about the horses', {}, 'morning four'));
  assert.equal(claudeBodies(host, before).length, 0, 'two stalls cool everyone');
  assert.match(gw.log(), /stays on MiMo: Claude cooling down after 2 strikes \(timeout\), 1[012]\d s left/);

  const spend = await get(gw.port, '/claude-spend');
  assert.equal(spend.conversations_held, 1);
  assert.equal(spend.fallbacks.refusal, 1);
  assert.equal(spend.fallbacks.timeout, 2);
  assert.equal(spend.cooldown.reason, '2 strikes (timeout)');
});

test('a credit-balance answer keeps everyone on MiMo for the half hour', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const r = await ask(gw.port, turn('horses please scenario credit'));
  assert.equal(words(r.text), MIMO_WORDS);
  assert.match(gw.log(), /fallback to MiMo: lane=buffered reason=credit status=400 after \d+ms -- Claude skipped for 30 min/);
  const before = host.bodies.length;
  const next = await ask(gw.port, turn('tell me about the horses', {}, 'a brand new chat'));
  assert.equal(words(next.text), MIMO_WORDS);
  assert.equal(claudeBodies(host, before).length, 0, 'no call to a failing Claude while the cooldown runs');
  assert.match(gw.log(), /stays on MiMo: Claude cooling down after credit, 1[78]\d\d s left/);
  const spend = await get(gw.port, '/claude-spend');
  assert.equal(spend.enabled, true);
  assert.equal(spend.fallbacks.credit, 1);
  assert.equal(spend.cooldown.reason, 'credit');
  assert.ok(spend.cooldown.seconds_left > 1700);
});

test('a short cooldown runs out and Claude is asked again; /claude-spend adds up the turns', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_CLAUDE_ERROR_COOLDOWN_MIN: '0.01' });
  t.after(() => gw.child.kill());

  await ask(gw.port, turn('horses please scenario http500'));
  assert.match(gw.log(), /reason=http_500 status=500 after \d+ms -- Claude skipped for 0 min/);
  let before = host.bodies.length;
  await ask(gw.port, turn('tell me about the horses'));
  assert.equal(claudeBodies(host, before).length, 0, 'inside the cooldown');
  await new Promise((r) => setTimeout(r, 800));
  before = host.bodies.length;
  const r = await ask(gw.port, turn('tell me about the horses'));
  assert.equal(claudeBodies(host, before).length, 1, 'the cooldown ran out');
  assert.equal(words(r.text), OPENING + REST);
  const toolTurn = await ask(gw.port, turn('what is the weather scenario tool'));
  assert.ok(toolTurn.text.includes('kade_weather'), 'a tool call from Claude reaches the agent');

  const spend = await get(gw.port, '/claude-spend');
  assert.equal(spend.turns, 2);
  assert.equal(spend.fallbacks.http_500, 1);
  assert.equal(spend.stayed_on_mimo['Claude cooling down after http_500'], 1);
  assert.equal(spend.real_cost_usd, 0.00348);
  assert.equal(spend.openrouter_usd, 0, 'her key paid: nothing came out of OpenRouter credit');
  assert.equal(spend.anthropic_credit_usd, 0.00348);
  assert.equal(spend.byok_turns, 2);
  assert.equal(spend.cached_share, 0.833);
  assert.equal(spend.tokens.reasoning, 100);
  assert.equal(spend.cooldown, null);
  assert.deepEqual(spend.warnings, []);
});

test('the BYOK guard: a turn OpenRouter credit paid for turns Claude off and tells the admin', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_BRIDGE_URL: `http://127.0.0.1:${host.port}`, BRIDGE_SECRET: 'bridge-test' });
  t.after(() => gw.child.kill());

  const r = await ask(gw.port, turn('tell me about the horses scenario nonbyok'));
  assert.equal(words(r.text), OPENING + REST, 'the turn itself is served');
  await new Promise((r2) => setTimeout(r2, 300));
  const loud = linesOf(gw.log(), /NOT PAID BY HER ANTHROPIC KEY/);
  assert.equal(loud.length, 1, gw.log().slice(-2000));
  assert.match(loud[0], /OpenRouter credit paid \$0\.001740 for this turn \(is_byok=false, lane=buffered, gen=gen-c\)\. Claude skipped for 1440 min\./);
  assert.equal(host.notes.length, 1, 'one admin alert');
  assert.equal(host.notes[0].secret, 'bridge-test');
  assert.equal(host.notes[0].adminAlert, true, 'to the owner');
  assert.equal(host.notes[0].agentId, 'claude-not_byok-alert');
  assert.match(host.notes[0].body, /not your Anthropic key/);

  const before = host.bodies.length;
  await ask(gw.port, turn('tell me about the horses', {}, 'another chat'));
  assert.equal(claudeBodies(host, before).length, 0, 'Claude is off');
  assert.match(gw.log(), /stays on MiMo: Claude cooling down after not_byok, 86\d\d\d s left/);
  const spend = await get(gw.port, '/claude-spend');
  assert.equal(spend.byok_only, true);
  assert.equal(spend.not_byok_turns, 1);
  assert.equal(spend.openrouter_usd, 0.00174);
  assert.match(spend.warnings[0], /^Claude is off: a turn was paid from OpenRouter credit/);
});
