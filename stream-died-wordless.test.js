'use strict';
/* Nov 10 2026 (bug sweep): a streamed reply that dies BEFORE its first word (the host ends the
 * stream with finish_reason "error", or the connection drops) used to be delivered as an empty
 * reply with finish_reason "stop": a screen-reader user hears nothing and sees nothing. The
 * re-ask that already saves a half-written reply now also covers the reply with no words.
 * Network stays on 127.0.0.1; nothing paid. */
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
function post(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret' } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('no answer in 30 s')));
    req.end(data);
  });
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
/** The words a client would read out of the gateway's SSE answer. */
function wordsOf(sse) {
  let words = '';
  for (const line of sse.split('\n')) {
    if (!line.startsWith('data: ') || line.includes('[DONE]')) continue;
    try { words += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
  }
  return words;
}
const REPLY = 'The oven goes to three hundred and fifty degrees, and the pie bakes for forty minutes.';
const body = (extra = {}) => ({ model: 'test/plain-model', stream: true,
  messages: [{ role: 'system', content: 'You are a helpful cook.' }, { role: 'user', content: 'How long does the pie bake, and how hot?' }], ...extra });

async function run(death, env = {}) {
  const asks = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const asked = JSON.parse(raw || '{}');
      asks.push(asked.stream ? 'stream' : 'plain');
      if (asked.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: {"id":"x","model":"test/plain-model","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n');
        if (death === 'finish-error') {
          res.end('data: {"id":"x","model":"test/plain-model","choices":[{"index":0,"delta":{},"finish_reason":"error"}]}\n\ndata: [DONE]\n\n');
        } else {
          setTimeout(() => res.destroy(), 50); // the connection drops mid-stream
        }
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id: 'y', model: 'test/plain-model',
        choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}`, ...env });
  try {
    const answer = await post(gw.port, body());
    return { answer, asks, words: wordsOf(answer.text), log: gw.log() };
  } finally {
    gw.child.kill();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
}

test('a stream that ends finish=error before any word is asked once more, and the words arrive', async () => {
  const { answer, asks, words, log } = await run('finish-error');
  assert.equal(answer.status, 200, log.slice(-800));
  assert.equal(asks[0], 'stream');
  assert.ok(asks.includes('plain'), `asked once more in one piece (asks: ${asks.join(',')})`);
  assert.ok(words.includes(REPLY), `the reply reached the client, got ${JSON.stringify(words)}`);
});

test('a connection that drops before any word is asked once more, and the words arrive', async () => {
  const { answer, asks, words, log } = await run('drop');
  assert.equal(answer.status, 200, log.slice(-800));
  assert.ok(asks.includes('plain'), `asked once more in one piece (asks: ${asks.join(',')})`);
  assert.ok(words.includes(REPLY), `the reply reached the client, got ${JSON.stringify(words)}`);
});

test('KADE_RETRY_TRUNCATED=0 still switches the re-ask off', async () => {
  const { asks, words } = await run('finish-error', { KADE_RETRY_TRUNCATED: '0' });
  assert.deepEqual(asks.filter((a) => a === 'plain'), []);
  assert.equal(words, '');
});
