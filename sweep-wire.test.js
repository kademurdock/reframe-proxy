'use strict';
/* Nov 13 2026 (post-release sweep), on the wire. Boots the real gateway against a fake host on 127.0.0.1 and
 * reads what a client and the log would see. Nothing paid.
 *  - a background run (x-kade-background: 1, or kade_background: true) sends MiMo Pro to the background
 *    order whatever KADE_MIMO_PROVIDER_ORDER says, and the body field never reaches a host;
 *  - a fast-start (kade_live) reply that stalls or drops after its first words ends with a notice and
 *    finish_reason 'length' inside KADE_SCREEN_IDLE_MS, not as a finished reply after 90 s;
 *  - a fast-start reply that repeats a voice-reel line is counted in the log (detect only);
 *  - the log carries no chat words unless KADE_LOG_TEXT=1. */
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
      PROXY_SHARED_SECRET: 'test-secret', KADE_AUTO_DEEPTHINK: '0', KADE_JEV: '0',
      ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...env }, // NODE_PATH: a clone whose packages are kept outside it
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
const chunk = (model, delta, finish = null) => sse({ id: 'x', model, choices: [{ index: 0, delta, finish_reason: finish }] });
const FIRST = 'So the thing about your fence is';
const SECRET_WORDS = 'my sister Marguerite crashed her motorcycle near Branson';

/* The fake host. The last user message picks what a streamed call does. Every body is recorded. */
async function fakeHost(reelLine) {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      const model = body.model || 'test/plain-model';
      const last = String(((body.messages || []).filter((m) => m.role === 'user').pop() || {}).content || '');
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'r', model, choices: [{ index: 0, message: { role: 'assistant', content: 'A whole answer, in one piece.' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(chunk(model, { role: 'assistant', content: /copies the reel/.test(last) ? reelLine : FIRST }));
      if (/goes quiet/.test(last)) return;                                      // words, then nothing
      if (/drops/.test(last)) { setTimeout(() => res.destroy(), 100); return; } // words, then the socket dies
      res.end(chunk(model, {}, 'stop') + 'data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  return { port, bodies, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

function ask(port, body, headers = {}, giveUpMs = 8000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ stream: true, ...body });
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret', ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { clearTimeout(giveUp); resolve({ text, ms: Date.now() - t0 }); });
    });
    const giveUp = setTimeout(() => { req.destroy(); resolve({ text: null, ms: Date.now() - t0 }); }, giveUpMs);
    req.on('error', (e) => { if (!/socket hang up|ECONNRESET/.test(String(e.message))) reject(e); });
    req.end(data);
  });
}
const msgs = (text, head = 'You are a warm friend.') => [{ role: 'system', content: head }, { role: 'user', content: text }];
const dones = (text) => text.split('data: [DONE]').length - 1;
const events = (text) => text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
const words = (text) => events(text).map((d) => (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) || '').join('');
const finishes = (text) => events(text).map((d) => d.choices && d.choices[0] && d.choices[0].finish_reason).filter(Boolean);

test('background: MiMo Pro goes to the background order by header or by body field; a waited-on turn keeps the set order', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_MIMO_PROVIDER_ORDER: 'PrimaLabs,DeepInfra' });
  t.after(() => gw.child.kill());
  const pro = { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, messages: msgs('What is on for today?') };

  await ask(gw.port, pro);
  assert.deepEqual(host.bodies.at(-1).provider.order, ['PrimaLabs', 'DeepInfra'], 'someone is waiting: the order as set');

  await ask(gw.port, pro, { 'x-kade-background': '1' });
  assert.deepEqual(host.bodies.at(-1).provider.order, ['DeepInfra']);
  assert.equal(host.bodies.at(-1).provider.zdr, true);

  await ask(gw.port, { ...pro, kade_background: true });
  assert.deepEqual(host.bodies.at(-1).provider.order, ['DeepInfra']);

  await ask(gw.port, { ...pro, stream: false, kade_background: true });
  assert.deepEqual(host.bodies.at(-1).provider.order, ['DeepInfra'], 'the one-piece route too');

  await ask(gw.port, { ...pro, kade_background: false });
  assert.deepEqual(host.bodies.at(-1).provider.order, ['PrimaLabs', 'DeepInfra'], 'false is not a background run');

  for (const b of host.bodies) assert.equal(Object.hasOwn(b, 'kade_background'), false, 'no host body carries kade_background');
  assert.equal((gw.log().match(/BACKGROUND run/g) || []).length, 3);
});

test('background: KADE_MIMO_BACKGROUND_ORDER empty turns the rule off', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_MIMO_PROVIDER_ORDER: 'PrimaLabs,DeepInfra', KADE_MIMO_BACKGROUND_ORDER: '' });
  t.after(() => gw.child.kill());
  await ask(gw.port, { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, messages: msgs('What is on for today?') }, { 'x-kade-background': '1' });
  assert.deepEqual(host.bodies.at(-1).provider.order, ['PrimaLabs', 'DeepInfra']);
});

for (const mode of ['goes quiet', 'drops']) {
  test(`fast start: a reply that ${mode} after its first words ends with the notice and finish_reason length`, async (t) => {
    const host = await fakeHost();
    t.after(() => host.close());
    const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_SCREEN_IDLE_MS: '400' });
    t.after(() => gw.child.kill());
    const r = await ask(gw.port, { model: 'test/plain-model', messages: msgs(`This one ${mode}.`), kade_live: true });
    assert.ok(r.text, 'the gateway was still holding the turn after 8 s:\n' + gw.log().slice(-1500));
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
    assert.ok(words(r.text).startsWith(FIRST));
    assert.match(words(r.text), /lost my train of thought there\. Ask me again/);
    assert.deepEqual(finishes(r.text), ['length'], 'a cut reply is never reported as a finished one');
    assert.equal(dones(r.text), 1);
    assert.equal(host.bodies.length, 1, 'no second paid call');
    assert.match(gw.log(), /screen-live stream (went quiet|dropped[^\n]*) after \d+ chars -- ended with the stall notice/);
  });
}

test('fast start: an empty KADE_SCREEN_STALL_NOTICE keeps the limit and the length ending without the words', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_SCREEN_IDLE_MS: '400', KADE_SCREEN_STALL_NOTICE: '' });
  t.after(() => gw.child.kill());
  const r = await ask(gw.port, { model: 'test/plain-model', messages: msgs('This one goes quiet.'), kade_live: true });
  assert.ok(r.text && r.ms < 5000);
  assert.equal(words(r.text), FIRST);
  assert.deepEqual(finishes(r.text), ['length']);
  assert.equal(dones(r.text), 1);
});

test('fast start: KADE_SCREEN_IDLE_MS=0 is the old 90 s wait, and a whole reply gets no notice', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_SCREEN_IDLE_MS: '0' });
  t.after(() => gw.child.kill());
  const whole = await ask(gw.port, { model: 'test/plain-model', messages: msgs('How is the fence?'), kade_live: true });
  assert.equal(words(whole.text), FIRST);
  assert.deepEqual(finishes(whole.text), ['stop']);
  const stuck = await ask(gw.port, { model: 'test/plain-model', messages: msgs('This one goes quiet.'), kade_live: true }, {}, 3000);
  assert.equal(stuck.text, null, 'still open at 3 s, as before the fix');
});

test('fast start: a reply that repeats a voice-reel line is counted in the log, and the log holds no chat words', async (t) => {
  const kiana = require('./voice-reel/kiana.json');
  const line = kiana.lines.find((l) => !l.salty && l.you.split(/\s+/).length >= 9);
  const head = 'house notes\n\n' + kiana.match + '\n## 3. How you talk\n...';
  const host = await fakeHost(line.you);
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_VOICE_REEL: '1' });
  t.after(() => gw.child.kill());

  const copied = await ask(gw.port, { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, messages: msgs(`This one copies the reel, and ${SECRET_WORDS}.`, head), kade_live: true });
  assert.equal(words(copied.text), line.you, 'the words went out as they came: detect only');
  assert.match(gw.log(), /\[echo-guard\]\[req \w+\] screen-live persona_parrot count=[1-9]\d* longest=\d+ words \(detect only\)/);

  const clean = await ask(gw.port, { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, messages: msgs('How is the fence?', head), kade_live: true });
  assert.equal(words(clean.text), FIRST);
  assert.equal((gw.log().match(/screen-live persona_parrot/g) || []).length, 1, 'an ordinary reply is not counted');

  // A buffered turn too (the think router and the last-message line both used to quote the message).
  await ask(gw.port, { model: 'xiaomi/mimo-v2.6-pro', messages: msgs(`${SECRET_WORDS}, and I keep going back and forth on what to tell her.`, head) });
  const log = gw.log();
  for (const w of ['Marguerite', 'motorcycle', 'Branson', 'back and forth']) assert.equal(log.includes(w), false, `the log quotes the message ("${w}")`);
  assert.equal(log.includes(line.you.slice(0, 30)), false, 'the log quotes the reply');
  assert.match(log, /lastUser shape=string phoneMarker=no tail=\(\d+ chars, sha [0-9a-f]{8}\)/);
});

test('KADE_LOG_TEXT=1 puts the words back for a bug hunt', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_LOG_TEXT: '1' });
  t.after(() => gw.child.kill());
  await ask(gw.port, { model: 'test/plain-model', messages: msgs(`${SECRET_WORDS}.`) });
  assert.match(gw.log(), /lastUser shape=string phoneMarker=no tail="[^"]*Branson\."/);
});
