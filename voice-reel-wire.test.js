'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');
const { HEADER } = require('./voice-reel');
// The talk note a default gateway sends (voice licence on); TALK_NOTE_BEFORE is the Nov 11 text.
const { TALK_NOTE_CASUAL_LICENSED: TALK_NOTE_CASUAL, TALK_NOTE_CASUAL: TALK_NOTE_BEFORE, TRUST_LISTENER_NOTE } = require('./talk-register');
const { conversationNoteFor } = require('./conversation-judgment');

/* The real server with the offline model fixture (no network: the fixture refuses every other URL).
 * With the switches on, the body that reaches the model carries the reel as turns after the head and
 * the card as the last words of the tail. With them off, the wire is what it is today. */
const PERSONA = "house notes\n\nYou're Kiana, the flagship intelligence of Kade-AI.\n\n## 3. How you talk\nLoose and direct.\n\n## Voice performance v2\nDirections in percent signs.";
const REPLY = "%%%amused%%% Nah, he ain't coming, and you know it.";
const PARROT = "%%%easy%%% Your eyes lying to you, basically. Anyway, what else is going on?";
const PORT = '31891';

async function run({ stream = false, env = {}, reply = REPLY, messages }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-reel-wire-')), receipt = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(receipt, '');
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'test-fixtures/model.cjs'), 'server.js'], { cwd: __dirname,
    env: { ...process.env, PORT, OPENROUTER_KEY: 'offline', PROXY_SHARED_SECRET: 'offline', ZAI_KEY: '', KADE_REPLY_FOCUS: '0', KADE_BRIDGE_URL: '', BRIDGE_SECRET: '', TYPESAFE_API_KEY: '',
      KADE_REGISTER_EDIT: '0', KADE_AUTO_DEEPTHINK: '0', MODEL_WIRE_RECEIPT: receipt, MODEL_WIRE_ORIGINAL: reply, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (x) => (log += x)); child.stderr.on('data', (x) => (log += x));
  try {
    let ready = false; for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch(`http://127.0.0.1:${PORT}/health`)).ok; } catch {} if (!ready) await new Promise((r) => setTimeout(r, 50)); }
    assert.ok(ready, log);
    const r = await fetch(`http://127.0.0.1:${PORT}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer offline' },
      body: JSON.stringify({ model: 'xiaomi/mimo-v2.6-pro', stream, max_tokens: 600, reasoning: { effort: 'none' },
        messages: messages || [{ role: 'system', content: PERSONA }, { role: 'user', content: 'is he coming or not' }] }) });
    assert.equal(r.status, 200);
    const raw = await r.text();
    const text = stream ? raw.split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6))).map((x) => x.choices?.[0]?.delta?.content || '').join('') : JSON.parse(raw).choices[0].message.content;
    const wire = fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((b) => b.model === 'xiaomi/mimo-v2.6-pro');
    return { text, wire, log };
  } finally { child.kill(); await new Promise((r) => child.once('exit', r)); }
}

const ON = { KADE_VOICE_REEL: '1', KADE_VOICE_CARD: '1', KADE_VOICE_REEL_DRAFTS: '1' };

test('switches off (the default): the wire is today\'s wire, and the meter still logs', async () => {
  for (const stream of [false, true]) {
    const r = await run({ stream });
    assert.equal(r.text, REPLY);
    const m = r.wire[0].messages;
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'system']);
    assert.ok(m[2].content.endsWith(TALK_NOTE_CASUAL), 'the talk note is still the last text');
    assert.ok(m[2].content.endsWith(conversationNoteFor(true, {}) + TRUST_LISTENER_NOTE + TALK_NOTE_CASUAL), 'conversation, trust, then talk, in the default wording');
    assert.ok(!JSON.stringify(r.wire).includes('VOICE REEL'));
    assert.match(r.log, /\[voice-meter\] \{.*"who":"Kiana".*"lane":"text".*"grammar":1/);
    const meter = r.log.split('\n').filter((l) => l.startsWith('[voice-meter]'));
    assert.equal(meter.length, 1, 'one meter line per reply');
    assert.ok(!/coming|you know it/.test(meter[0]), 'the meter line carries counts, never the reply');
  }
});

test('switches on: reel after the head, real turn after the reel, card last, reply untouched', async () => {
  for (const stream of [false, true]) {
    const r = await run({ stream, env: ON });
    assert.equal(r.text, REPLY, 'stream=' + stream);
    const m = r.wire[0].messages;
    assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'system']);
    assert.equal(m[0].content, PERSONA, 'the head is byte for byte, so its cache holds');
    for (const i of [1, 3, 5, 7]) { assert.ok(m[i].content.startsWith(HEADER)); assert.match(m[i + 1].content, /^%%%[^%\n]+%%% \S/); }
    assert.equal(m[9].content, 'is he coming or not');
    assert.match(m[10].content, /Private, just me talking to me before I answer\.[\s\S]*When I'm done, I'm done\.$/);
    assert.ok(m[10].content.includes(TALK_NOTE_CASUAL), 'the measured talk note still rides, right before the card');
    assert.match(r.log, /\[voice-meter\] \{.*"reel":\["k/);
  }
});

test('a reply that repeats a reel line is caught by the parrot guard', async () => {
  const r = await run({ env: ON, reply: PARROT });
  assert.match(r.log, /\[echo-guard\] persona_parrot: "your eyes lying to you basically/);
});

test('another character gets neither piece', async () => {
  const other = await run({ env: ON, messages: [{ role: 'system', content: 'You are Earl, 72, a retired long-haul trucker.' }, { role: 'user', content: 'is he coming or not' }] });
  assert.deepEqual(other.wire[0].messages.map((x) => x.role), ['system', 'user', 'system']);
  assert.ok(other.wire[0].messages[2].content.endsWith(TALK_NOTE_CASUAL));
});

test('the reel survives the think router and a later turn keeps the same reel', async () => {
  const long = 'okay so why do you think he keeps saying he will come and then never shows up, because I have asked him four separate times now and every single time it is a different excuse and I am tired of it';
  const first = await run({ stream: true, env: { ...ON, KADE_AUTO_DEEPTHINK: '1' }, messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: long }] });
  const m1 = first.wire[first.wire.length - 1].messages;
  assert.equal(m1.filter((x) => x.role === 'user' && x.content.startsWith(HEADER)).length, 4);
  const later = await run({ stream: true, env: { ...ON, KADE_AUTO_DEEPTHINK: '1' }, messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: long },
    { role: 'assistant', content: REPLY }, { role: 'user', content: 'ha. fair enough' }] });
  const m2 = later.wire[later.wire.length - 1].messages;
  assert.deepEqual(m2.slice(0, 9), m1.slice(0, 9), 'head and reel are byte for byte the same on a later turn');
});

test('KADE_VOICE_REEL=1 alone does nothing: the shipped pools are drafts until a pool says approved', async () => {
  const r = await run({ env: { KADE_VOICE_REEL: '1', KADE_VOICE_CARD: '1' } });
  assert.deepEqual(r.wire[0].messages.map((x) => x.role), ['system', 'user', 'system']);
  assert.ok(r.wire[0].messages[2].content.endsWith(TALK_NOTE_CASUAL));
  assert.ok(!JSON.stringify(r.wire).includes('VOICE REEL'));
});

test('typed turns only: a phone turn goes without the reel unless KADE_VOICE_REEL_CALLS=1', async () => {
  const phone = [{ role: 'system', content: PERSONA }, { role: 'user', content: '[PHONE CALL] is he coming or not' }];
  const call = await run({ env: ON, messages: phone });
  assert.equal(call.wire[0].messages.filter((x) => x.role === 'assistant').length, 0, 'no seed turns on a call');
  assert.ok(!JSON.stringify(call.wire).includes('VOICE REEL'));
  const optIn = await run({ env: { ...ON, KADE_VOICE_REEL_CALLS: '1' }, messages: phone });
  assert.equal(optIn.wire[0].messages.filter((x) => x.role === 'user' && x.content.startsWith(HEADER)).length, 4);
});

test('KADE_VOICE_LICENCE=0: the tail ends on the talk note as it was, byte for byte', async () => {
  const r = await run({ env: { KADE_VOICE_LICENCE: '0' } });
  const tail = r.wire[0].messages[2].content;
  assert.ok(tail.endsWith(TALK_NOTE_BEFORE));
  assert.ok(!tail.endsWith(TALK_NOTE_CASUAL));
  assert.notEqual(TALK_NOTE_BEFORE, TALK_NOTE_CASUAL);
});
