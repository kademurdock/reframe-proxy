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
    const t0 = Date.now();
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret' } }, (res) => {
      let text = '';
      const writes = []; // when each piece reached the client, ms after the request
      res.on('data', (c) => { text += c; writes.push({ at: Date.now() - t0, text: String(c) }); });
      res.on('end', () => resolve({ status: res.statusCode, text, writes }));
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
/** Every parsed data frame of the gateway's SSE answer. */
const framesOf = (sse) => sse.split('\n').filter((l) => l.startsWith('data: ') && !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
const REPLY = 'The oven goes to three hundred and fifty degrees, and the pie bakes for forty minutes.';
const body = (extra = {}) => ({ model: 'test/plain-model', stream: true,
  messages: [{ role: 'system', content: 'You are a helpful cook.' }, { role: 'user', content: 'How long does the pie bake, and how hot?' }], ...extra });
const PLAIN = { id: 'y', model: 'test/plain-model',
  choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } };
const TOOLS = [{ type: 'function', function: { name: 'web_search', description: 'Search the web.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
const CALL = { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"pie baking time"}' } };

/* death: how the streamed ask dies. opts.plain: what the one-piece re-ask answers.
 * opts.delayMs: how long that answer takes. opts.request: extra fields on the client's body. */
async function run(death, env = {}, opts = {}) {
  const asks = [];
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const asked = JSON.parse(raw || '{}');
      asks.push(asked.stream ? 'stream' : 'plain');
      bodies.push(asked);
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
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(opts.plain || PLAIN));
      }, opts.delayMs || 0);
    });
  });
  const upstreamPort = await listen(upstream);
  /* The boot sits INSIDE the try: when the gateway fails to start, the fake host above must
   * still be closed, or its open listener keeps this test file alive for ever. */
  let gw;
  try {
    gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}`, ...env });
    const answer = await post(gw.port, body(opts.request));
    await new Promise((r) => setTimeout(r, 250)); // let the gateway's last log lines arrive
    return { answer, asks, bodies, words: wordsOf(answer.text), frames: framesOf(answer.text), log: gw.log() };
  } finally {
    if (gw) gw.child.kill();
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

/* -- Nov 10 2026 (independent review): what the re-ask must do with a tool call, with its
 * usage, and with the line while it waits. --------------------------------------------- */

const toolDeltas = (frames) => frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls || []);
const finishes = (frames) => frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean);
const usages = (frames) => frames.filter((f) => f.usage).map((f) => f.usage);

test('the re-ask answers with a tool call: the client gets the call and the usage, not an empty reply', async () => {
  const plain = { id: 'y', model: 'test/plain-model',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [CALL] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } };
  const { answer, asks, bodies, frames, words, log } = await run('finish-error', {}, { plain, request: { tools: TOOLS } });
  assert.equal(answer.status, 200, log.slice(-800));
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(bodies[1].tools.length, 1, 'the re-ask carries the tools, so a tool call is a fair answer');
  const calls = toolDeltas(frames);
  assert.equal(calls.length, 1, `the tool call reached the client: ${answer.text}`);
  assert.equal(calls[0].id, 'call_1');
  assert.equal(calls[0].function.name, 'web_search');
  assert.equal(calls[0].function.arguments, CALL.function.arguments);
  assert.equal(words, '');
  assert.deepEqual(finishes(frames), ['tool_calls']);
  assert.equal(usages(frames).length, 1, 'one usage frame');
  assert.equal(usages(frames)[0].prompt_tokens, 300);
  assert.equal(usages(frames)[0].completion_tokens, 200);
  assert.match(answer.text, /data: \[DONE\]/);
  assert.match(log, /truncation retry usage: prompt=300 completion=200/);
  assert.match(log, /truncation retry tool turn sent/);
});

test('the re-ask answers with a lead-in sentence and a tool call: both arrive together, never the sentence alone', async () => {
  const plain = { id: 'y', model: 'test/plain-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'Let me look that up for you.', tool_calls: [CALL] }, finish_reason: 'tool_calls' }] };
  const { answer, frames, words } = await run('drop', {}, { plain, request: { tools: TOOLS } });
  assert.equal(toolDeltas(frames).length, 1, `the tool call reached the client: ${answer.text}`);
  assert.equal(words, 'Let me look that up for you.');
  assert.deepEqual(finishes(frames), ['tool_calls']);
});

test('a words-only re-ask never goes out marked finish_reason "tool_calls"', async () => {
  const plain = { ...PLAIN, choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'tool_calls' }] };
  const { frames, words } = await run('finish-error', {}, { plain, request: { tools: TOOLS } });
  assert.ok(words.includes(REPLY));
  assert.equal(toolDeltas(frames).length, 0);
  assert.deepEqual(finishes(frames), ['stop']);
});

test('a re-ask that comes back empty is still counted: its usage reaches the client and the log', async () => {
  const plain = { id: 'y', model: 'test/plain-model',
    choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 300, completion_tokens: 7, total_tokens: 307 } };
  const { frames, words, log } = await run('finish-error', {}, { plain });
  assert.equal(words, '');
  assert.equal(usages(frames).length, 1, 'the paid call is not dropped');
  assert.equal(usages(frames)[0].prompt_tokens, 300);
  assert.match(log, /truncation retry usage: prompt=300 completion=7/);
  assert.match(log, /came back shorter or empty/);
});

test('the line stays warm while a slow re-ask runs: a keep-alive reaches the client before the words', async () => {
  // The gateway's heartbeat is every 10 s; the re-ask here takes 12 s.
  const { answer, words } = await run('finish-error', {}, { delayMs: 12000 });
  assert.ok(words.includes(REPLY));
  const firstWords = answer.writes.find((w) => w.text.includes(REPLY));
  const beats = answer.writes.filter((w) => w.text.includes(': keep-alive') && w.at < firstWords.at);
  assert.ok(beats.length >= 1, `a keep-alive arrived during the wait (writes at ${answer.writes.map((w) => w.at).join(', ')} ms)`);
  assert.ok(beats[0].at < 11500, `the first keep-alive came within one heartbeat, at ${beats[0].at} ms`);
});

test('a gateway that fails to boot fails the run at once and leaves nothing listening', async () => {
  // With no key the gateway prints FATAL and exits at start.
  await assert.rejects(run('finish-error', { OPENROUTER_KEY: '' }), /gateway did not boot/);
  // Nothing else to assert here: if run() left its fake host listening, this file never exits.
});
