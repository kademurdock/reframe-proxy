'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), { spawn } = require('node:child_process');

/* The real server with the offline model fixture: the register edit runs on the return path of a
 * character reply, streamed and not, and KADE_REGISTER_EDIT=0 leaves the reply byte-identical. */
const PERSONA = '# Earl\n\nYou are Earl, 72, a retired long-haul trucker.\n\n## How you talk\nSlow, plain porch talk.\n\n## Voice performance v2\nDirections in percent signs.';
const DRAFT = "%%%easy and warm%%% Well, that's a question with legs. There's real reasons for it. Old dogs lose the high notes first, usually, so your bright calling voice is the first thing to go. The low stuff, the door, the treat bag, all that still comes through fine for a good long while. Ruthie used to laugh at how he heard the cheese drawer from the porch. So the long and short of it is the high notes go first.";
const PATCH = { edits: [
  { kind: 'setup', before: "There's real reasons for it.", after: '' },
  { kind: 'padding', before: 'So the long and short of it is the high notes go first.', after: '' },
] };

test('return path: the register edit makes its local edits, logs them, and the switch turns it off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'register-wire-')), receipt = path.join(dir, 'requests.jsonl');
  async function run({ stream, env = {} }) {
    fs.writeFileSync(receipt, '');
    const child = spawn(process.execPath, ['--require', path.join(__dirname, 'test-fixtures/model.cjs'), 'server.js'], { cwd: __dirname, env: { ...process.env, PORT: '31883', OPENROUTER_KEY: 'offline', PROXY_SHARED_SECRET: 'offline', ZAI_KEY: '', KADE_REPLY_FOCUS: '0', KADE_BRIDGE_URL: '', BRIDGE_SECRET: '', TYPESAFE_API_KEY: '', MODEL_WIRE_RECEIPT: receipt, MODEL_WIRE_ORIGINAL: DRAFT, MODEL_WIRE_PATCH: JSON.stringify(PATCH), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; child.stdout.on('data', (x) => (log += x)); child.stderr.on('data', (x) => (log += x));
    try {
      let ready = false; for (let i = 0; i < 100 && !ready; i++) { try { ready = (await fetch('http://127.0.0.1:31883/health')).ok; } catch {} if (!ready) await new Promise((r) => setTimeout(r, 50)); }
      assert.ok(ready, log);
      const r = await fetch('http://127.0.0.1:31883/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer offline' },
        body: JSON.stringify({ model: 'xiaomi/mimo-v2.6-pro', stream, max_tokens: 600, reasoning: { effort: 'none' }, messages: [{ role: 'system', content: PERSONA }, { role: 'user', content: 'Why do old dogs act deaf?' }] }) });
      assert.equal(r.status, 200);
      const raw = await r.text();
      const text = stream ? raw.split('\n').filter((x) => x.startsWith('data: {')).map((x) => JSON.parse(x.slice(6))).map((x) => x.choices?.[0]?.delta?.content || '').join('') : JSON.parse(raw).choices[0].message.content;
      const calls = fs.readFileSync(receipt, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter((b) => String(b.messages?.[0]?.content || '').startsWith('You edit one chat reply'));
      const health = await (await fetch('http://127.0.0.1:31883/health', { headers: { Authorization: 'Bearer offline' } })).json();
      return { text, calls, log, health };
    } finally { child.kill(); await new Promise((r) => child.once('exit', r)); }
  }
  const expected = DRAFT.replace(" There's real reasons for it.", '').replace(' So the long and short of it is the high notes go first.', '');
  for (const stream of [false, true]) {
    const r = await run({ stream });
    assert.equal(r.text, expected, 'stream=' + stream);
    assert.equal(r.calls.length, 1);
    const call = r.calls[0];
    assert.equal(call.model, 'xiaomi/mimo-v2.6-flash');
    assert.equal(call.provider.zdr, true);
    assert.equal(call.provider.data_collection, 'deny');
    assert.equal(call.reasoning.enabled, false);
    assert.match(call.messages[1].content, /Character: Earl/);
    assert.match(r.log, /\[register-edit\] .*"status":"edited"/);
    assert.equal(r.health.registerEdit.enabled, true);
    assert.equal(r.health.registerEdit.counts.edited, 1);
  }
  const off = await run({ stream: false, env: { KADE_REGISTER_EDIT: '0' } });
  assert.equal(off.text, DRAFT);
  assert.equal(off.calls.length, 0);
  assert.doesNotMatch(off.log, /\[register-edit\]/);
});
