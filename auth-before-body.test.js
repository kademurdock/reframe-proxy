'use strict';
/* Nov 12 2026 (gateway audit GW-8): the bearer is checked BEFORE the body is read. This service is on a
 * public domain and used to buffer and JSON.parse up to 10 MB for anyone before saying 401. Boots the real
 * gateway (same boot as editor-hangup.test.js) against a stub host on 127.0.0.1. Nothing paid. */
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

/* Raw socket: headers announcing a 9 MB body, then 1 KB of it, then nothing. Resolves with what came back
 * and whether the server closed the socket, or { text: null } if nothing came back in time. */
function partialPost(port, pathName, { waitMs = 2000 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let text = '';
    const t0 = Date.now();
    let firstAt = null;
    const done = (closed) => { clearTimeout(timer); sock.destroy(); resolve({ text: text || null, ms: firstAt, closed }); };
    const timer = setTimeout(() => done(false), waitMs);
    sock.on('data', (c) => { if (firstAt === null) firstAt = Date.now() - t0; text += c; });
    sock.on('end', () => done(true));
    sock.on('close', () => done(true));
    sock.on('error', () => {});
    sock.on('connect', () => {
      sock.write(`POST ${pathName} HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 9000000\r\nConnection: keep-alive\r\n\r\n`);
      sock.write('[' + '{},'.repeat(340));
    });
  });
}

test('without the bearer, a big body is refused before it is read, on any path', async (t) => {
  const gw = await boot({});
  t.after(() => gw.child.kill());
  for (const p of ['/chat/completions', '/health']) {
    const r = await partialPost(gw.port, p);
    assert.ok(r.text, `${p}: nothing came back while the body was still owed`);
    assert.match(r.text, /^HTTP\/1\.1 401/, p);
    assert.match(r.text, /connection: close/i, p);
    assert.ok(r.ms < 500, `${p}: answered after ${r.ms} ms`);
    assert.ok(r.closed, `${p}: the socket was closed`);
  }
});

test('GET and HEAD /health need no bearer; the details still do', async (t) => {
  const gw = await boot({});
  t.after(() => gw.child.kill());
  const open = await fetch(`http://127.0.0.1:${gw.port}/health`);
  assert.equal(open.status, 200);
  const body = await open.json();
  assert.equal(body.status, 'ok');
  assert.equal(Object.hasOwn(body, 'zai'), false);
  assert.equal((await fetch(`http://127.0.0.1:${gw.port}/health`, { method: 'HEAD' })).status, 200);
  const full = await (await fetch(`http://127.0.0.1:${gw.port}/health`, { headers: { Authorization: 'Bearer test-secret' } })).json();
  for (const k of ['zai', 'replyFocus', 'registerEdit', 'jev']) assert.ok(Object.hasOwn(full, k), k);
});

test('with the bearer: a turn still works, an 11 MB body is 413 and bad JSON is 400', async (t) => {
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', object: 'chat.completion', model: 'test/plain-model',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Stub says hello.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}`, KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); upstream.closeAllConnections(); await new Promise((r) => upstream.close(r)); });
  const auth = { 'Content-Type': 'application/json', Authorization: 'Bearer test-secret' };
  const ok = await fetch(`http://127.0.0.1:${gw.port}/chat/completions`, { method: 'POST', headers: auth,
    body: JSON.stringify({ model: 'test/plain-model', messages: [{ role: 'user', content: 'Hello?' }] }) });
  assert.equal(ok.status, 200, gw.log().slice(-1500));
  assert.match(JSON.stringify(await ok.json()), /Stub says hello/);
  const big = await fetch(`http://127.0.0.1:${gw.port}/chat/completions`, { method: 'POST', headers: auth, body: 'x'.repeat(11 * 1024 * 1024) });
  assert.equal(big.status, 413);
  const bad = await fetch(`http://127.0.0.1:${gw.port}/chat/completions`, { method: 'POST', headers: auth, body: '{"model":' });
  assert.equal(bad.status, 400);
  const noBearerBad = await fetch(`http://127.0.0.1:${gw.port}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"model":' });
  assert.equal(noBearerBad.status, 401, 'malformed JSON without the bearer is a 401 now, not a 400');
});
