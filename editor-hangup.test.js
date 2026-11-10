'use strict';
/* Nov 10 2026 (call limits lane): the editor passes stop when the person hangs up.
 *
 * The reply's own model call has been cancelled on a hang-up since Oct 16. The slop rewrite that
 * runs on the finished reply carried no signal: after a Stop it ran on to its own limit (25 s),
 * paid, for an answer nobody would get. This boots the real gateway against a fake host on
 * 127.0.0.1 whose rewrite call never answers, hangs up, and times how long the gateway keeps that
 * rewrite call open. Nothing paid. */
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

// A reply with a stock label the phrase repair is built to catch, so the gateway spends an editor call on it.
const SLOPPY = "That's some main character energy. I like Nessa, but damn, she got mad when we already had plans. I think she was wrong.";
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

/* The client asks, waits `hangUpAfterMs` once the rewrite call has reached the host, then drops
 * its connection. Returns how long the rewrite call stayed open after the hang-up, or null if the
 * gateway was still holding it when `watchMs` ran out. */
async function run(env, { hangUpAfterMs = 300, watchMs = 4000 } = {}) {
  let rewriteArrived;
  const arrived = new Promise((r) => { rewriteArrived = r; });
  let rewriteClosedAt = null;
  const asks = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const asked = JSON.parse(raw || '{}');
      if (asked.stream) {
        asks.push('reply');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse({ id: 'x', model: 'test/plain-model', choices: [{ index: 0, delta: { role: 'assistant', content: SLOPPY }, finish_reason: null }] }));
        res.write(sse({ id: 'x', model: 'test/plain-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
        return;
      }
      // Any one-piece call here is an editor pass. It never answers.
      asks.push('editor');
      res.on('close', () => { if (rewriteClosedAt === null) rewriteClosedAt = Date.now(); });
      rewriteArrived();
    });
  });
  const upstreamPort = await listen(upstream);
  let gw;
  try {
    gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}`, ...env });
    const data = JSON.stringify({ model: 'test/plain-model', stream: true,
      messages: [{ role: 'system', content: 'You are a warm friend.' }, { role: 'user', content: 'What do you think of Nessa?' }] });
    const req = http.request({ host: '127.0.0.1', port: gw.port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret' } });
    req.on('error', () => {});
    req.on('response', (res) => { res.on('data', () => {}); res.on('error', () => {}); });
    req.end(data);
    await Promise.race([arrived, new Promise((_, rej) => setTimeout(() => rej(new Error('the gateway never spent an editor call on the sloppy reply:\n' + gw.log().slice(-1500))), 10000))]);
    await new Promise((r) => setTimeout(r, hangUpAfterMs));
    const hungUpAt = Date.now();
    req.destroy();
    const until = Date.now() + watchMs;
    while (rewriteClosedAt === null && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    return { openForMs: rewriteClosedAt === null ? null : rewriteClosedAt - hungUpAt, asks, log: gw.log() };
  } finally {
    if (gw) gw.child.kill();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
}

test('a hang-up during the rewrite pass cancels the rewrite call at once', async () => {
  const { openForMs, asks, log } = await run({});
  assert.ok(asks.includes('editor'), 'the rewrite pass ran');
  assert.notEqual(openForMs, null, 'the rewrite call was closed while we watched (4 s); it used to run to its 25 s limit\n' + log.slice(-600));
  assert.ok(openForMs < 2000, `closed ${openForMs} ms after the hang-up`);
  assert.match(log, /client hung up after/);
});

test('KADE_EDITOR_HANGUP_CANCEL=0 puts the old behaviour back: the rewrite call outlives the hang-up', async () => {
  const { openForMs, asks } = await run({ KADE_EDITOR_HANGUP_CANCEL: '0' }, { watchMs: 2500 });
  assert.ok(asks.includes('editor'));
  assert.equal(openForMs, null, 'still open 2.5 s after the hang-up');
});

test('a client that stays gets its rewrite as before (the signal changes nothing for a live turn)', async () => {
  // Same sloppy reply, but this time the editor answers and the client waits for the end.
  const CLEAN = JSON.stringify({ edits: [{ id: 0, before: "That's some main character energy.", after: '' }] });
  const asks = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const asked = JSON.parse(raw || '{}');
      if (asked.stream) {
        asks.push('reply');
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(sse({ id: 'x', model: 'test/plain-model', choices: [{ index: 0, delta: { role: 'assistant', content: SLOPPY }, finish_reason: null }] }));
        res.write(sse({ id: 'x', model: 'test/plain-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
        res.end('data: [DONE]\n\n');
        return;
      }
      asks.push('editor');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'r', model: 'test/editor', choices: [{ index: 0, message: { role: 'assistant', content: CLEAN }, finish_reason: 'stop' }] }));
    });
  });
  const upstreamPort = await listen(upstream);
  let gw;
  try {
    gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}` });
    const data = JSON.stringify({ model: 'test/plain-model', stream: true,
      messages: [{ role: 'system', content: 'You are a warm friend.' }, { role: 'user', content: 'What do you think of Nessa?' }] });
    const text = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: gw.port, path: '/chat/completions', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret' } }, (res) => {
        let t = '';
        res.on('data', (c) => { t += c; });
        res.on('end', () => resolve(t));
      });
      req.on('error', reject);
      req.end(data);
    });
    let words = '';
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
      try { words += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
    }
    assert.ok(asks.includes('editor'), 'the rewrite pass ran');
    assert.ok(words.includes('I like Nessa'), `the reply reached the client, got ${JSON.stringify(words)}`);
    assert.doesNotMatch(words, /main character energy/, 'the edit was applied');
  } finally {
    if (gw) gw.child.kill();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
});
