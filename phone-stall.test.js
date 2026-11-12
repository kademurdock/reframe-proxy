'use strict';
/* Nov 12 2026 (gateway audit GW-2): a phone reply that stalls after its first words ends with a spoken notice
 * after KADE_PHONE_IDLE_MS of no data events from the host (keep-alive comments do not count), instead of
 * 90 s of silence. Boots the real gateway against a fake host on 127.0.0.1. Nothing paid. */
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
      PROXY_SHARED_SECRET: 'test-secret', KADE_AUTO_DEEPTHINK: '0', ...env },
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
const NOTICE = 'Sorry, I lost my train of thought there.';

/* mode 'quiet': one word, then nothing. 'comments': one word, then a keep-alive comment every 100 ms.
 * 'finished': the whole reply and its finish_reason, then nothing (no [DONE]). */
async function run(mode, env = {}) {
  let hostClosedAt = null;
  const upstream = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.on('close', () => { hostClosedAt = Date.now(); });
      res.write(sse({ id: 'x', model: 'test/plain-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'So the thing about your fence is' }, finish_reason: null }] }));
      if (mode === 'finished') res.write(sse({ id: 'x', model: 'test/plain-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
      if (mode === 'comments') {
        const beat = setInterval(() => { try { res.write(': OPENROUTER PROCESSING\n\n'); } catch (e) {} }, 100);
        res.on('close', () => clearInterval(beat));
      }
    });
  });
  const upstreamPort = await listen(upstream);
  let gw;
  try {
    gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}`, KADE_PHONE_IDLE_MS: '400', ...env });
    const data = JSON.stringify({ model: 'test/plain-model', stream: true,
      messages: [{ role: 'system', content: 'You are a warm friend.' }, { role: 'user', content: '[PHONE CALL] How is the fence?' }] });
    const t0 = Date.now();
    const body = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gw.port, path: '/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret' } });
      const giveUp = setTimeout(() => { req.destroy(); resolve(null); }, 4000);
      req.on('error', reject);
      req.on('response', (res) => { let out = ''; res.on('data', (c) => { out += c; }); res.on('end', () => { clearTimeout(giveUp); resolve(out); }); });
      req.end(data);
    });
    const tookMs = Date.now() - t0;
    await new Promise((r) => setTimeout(r, 200));
    return { body, tookMs, hostClosed: hostClosedAt !== null, log: gw.log() };
  } finally {
    if (gw) gw.child.kill();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
}

for (const mode of ['quiet', 'comments']) {
  test(`a phone reply that stalls after its first words (${mode}) ends with the notice`, async () => {
    const r = await run(mode);
    assert.ok(r.body, 'the gateway was still holding the turn after 4 s:\n' + r.log.slice(-1500));
    assert.ok(r.tookMs < 1500, `took ${r.tookMs}ms`);
    assert.ok(r.body.includes('So the thing about your fence is'));
    assert.ok(r.body.indexOf(NOTICE) > r.body.indexOf('fence is'), 'notice after the partial words');
    assert.ok(r.body.trimEnd().endsWith('data: [DONE]'));
    assert.ok(r.hostClosed, 'the host connection was left open');
    assert.match(r.log, /phone stream went quiet after \d+ chars/);
  });
}

test('a reply that finished and then stalled before [DONE] ends early with no notice', async () => {
  const r = await run('finished');
  assert.ok(r.body && r.tookMs < 1500);
  assert.ok(!r.body.includes(NOTICE));
  assert.equal(r.body.split('"finish_reason":"stop"').length - 1, 1);
  assert.ok(r.body.trimEnd().endsWith('data: [DONE]'));
});

test('KADE_PHONE_IDLE_MS=0 leaves the old 90 s limit alone', async () => {
  const r = await run('quiet', { KADE_PHONE_IDLE_MS: '0' });
  assert.equal(r.body, null); // still open at 4 s, as before the fix
});
