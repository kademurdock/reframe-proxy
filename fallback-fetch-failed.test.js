'use strict';
/* Nov 10 2026 (bug sweep): when a direct host (Z.AI or Moonshot) refuses a streamed call
 * with a fallback status and the OpenRouter fallback fetch ALSO fails, the handler used to
 * read the already-read first answer again ("Body is unusable"), reject, and with no
 * rejection handler the whole gateway exited: every reply in flight died with it.
 * The gateway must answer 502 and stay up. Network stays on 127.0.0.1; nothing paid. */
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
function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret', ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('no answer in 20 s')));
    req.end(data);
  });
}
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject);
});

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
    if (Date.now() > until) { child.kill(); throw new Error('gateway boot timed out:\n' + out.slice(-2000)); }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { port, child, log: () => out, exited: () => exited };
}

for (const lane of [
  { name: 'Z.AI', model: 'z-ai/glm-5.3', env: (url) => ({ ZAI_KEY: 'test-only', ZAI_BASE: url }) },
  { name: 'Moonshot', model: 'moonshotai/kimi-k2.6', env: (url) => ({ MOONSHOT_KEY: 'test-only', MOONSHOT_BASE: url }) },
]) {
  test(`${lane.name} refuses with 402 and the OpenRouter fallback cannot be reached: 502, and the gateway stays up`, async () => {
    let directHits = 0;
    const direct = http.createServer((req, res) => {
      req.resume();
      directHits += 1;
      res.writeHead(402, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"Insufficient balance"}}');
    });
    const directPort = await listen(direct);
    const deadPort = await freePort(); // nothing listens: the fallback fetch fails at once
    const gw = await boot({ ...lane.env(`http://127.0.0.1:${directPort}`), OPENROUTER_BASE: `http://127.0.0.1:${deadPort}` });
    try {
      const answer = await post(gw.port, { model: lane.model, stream: true, messages: [{ role: 'user', content: 'hello' }] });
      assert.ok(directHits >= 1, `the direct host was asked (log: ${gw.log().slice(-600)})`);
      assert.equal(answer.status, 502, answer.text);
      assert.match(JSON.parse(answer.text).error.message, /Upstream request failed/);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(gw.exited(), null, 'the gateway process is still running');
      assert.equal(await get(gw.port, '/health'), 200);
    } finally {
      gw.child.kill();
      direct.closeAllConnections();
      await new Promise((r) => direct.close(r));
    }
  });
}
