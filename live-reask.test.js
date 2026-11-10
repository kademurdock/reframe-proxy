'use strict';
/* Nov 10 2026 (call limits lane): the single re-ask on the two LIVE lanes, behind KADE_LIVE_REASK=1.
 *
 * The re-ask of e763a42 / a560a7f covers the buffered web and chat lane only. A phone turn, and a
 * turn on a model whose tools are written into the prompt (tool-shim-live), that died with an error
 * or a dropped connection before its first word was still delivered empty. These tests boot the
 * real gateway against a fake host on 127.0.0.1 and read what a client would read. Nothing paid.
 *
 * The switch is OFF by default, and the first job of this file is to show that OFF is byte for byte
 * what the gateway did before, and that ON changes nothing for a turn that is healthy. */
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
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text, ms: Date.now() - t0 }));
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

const dataLines = (sse) => sse.split('\n').filter((l) => l.startsWith('data: '));
const framesOf = (sse) => dataLines(sse).filter((l) => !l.includes('[DONE]')).map((l) => JSON.parse(l.slice(6)));
const wordsOf = (sse) => framesOf(sse).map((f) => f.choices?.[0]?.delta?.content || '').join('');
const toolDeltas = (frames) => frames.flatMap((f) => f.choices?.[0]?.delta?.tool_calls || []);
const finishes = (frames) => frames.map((f) => f.choices?.[0]?.finish_reason).filter(Boolean);
const usages = (frames) => frames.filter((f) => f.usage).map((f) => f.usage);
const doneCount = (sse) => dataLines(sse).filter((l) => l.trim() === 'data: [DONE]').length;
/** The answer with the gateway's own keep-alive comments taken out: what the host's events became. */
const eventsOnly = (sse) => sse.split('\n\n').filter((e) => e.trim() && !e.startsWith(':')).join('\n\n');

const REPLY = 'The oven goes to three hundred and fifty degrees, and the pie bakes for forty minutes.';
const PHONE_MARK = '\n\n[PHONE CALL - reply in short spoken sentences.]';
const TOOLS = [{ type: 'function', function: { name: 'web_search', description: 'Search the web.',
  parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } } }];
const CALL = { id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"pie baking time"}' } };
const PLAIN = { id: 'y', model: 'test/plain-model',
  choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 } };

const phoneBody = (extra = {}) => ({ model: 'test/plain-model', stream: true,
  messages: [{ role: 'system', content: 'You are a helpful cook.' }, { role: 'user', content: 'How long does the pie bake, and how hot?' + PHONE_MARK }], ...extra });
const SHIM_MODEL = 'nousresearch/hermes-4-70b';
const shimBody = (extra = {}) => ({ model: SHIM_MODEL, stream: true, tools: TOOLS,
  messages: [{ role: 'system', content: 'You are a helpful cook.' }, { role: 'user', content: 'How long does the pie bake, and how hot?' }], ...extra });

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const chunk = (delta, finish = null, model = 'test/plain-model') => ({ id: 'x', model, choices: [{ index: 0, delta, finish_reason: finish }] });
const ROLE = chunk({ role: 'assistant', content: '' });

/* How the streamed ask goes. Each returns what the fake host writes and whether it then drops. */
const STREAMS = {
  'finish-error': { events: [sse(ROLE), sse(chunk({}, 'error')), 'data: [DONE]\n\n'] },
  drop: { events: [sse(ROLE)], drop: true },
  healthy: { events: [sse(ROLE), sse(chunk({ content: 'Forty minutes' })), sse(chunk({ content: ' at three fifty.' })), sse(chunk({}, 'stop')), 'data: [DONE]\n\n'] },
  'half-then-error': { events: [sse(ROLE), sse(chunk({ content: 'Forty min' })), sse(chunk({}, 'error')), 'data: [DONE]\n\n'] },
  'space-then-error': { events: [sse(ROLE), sse(chunk({ content: ' ' })), sse(chunk({}, 'error')), 'data: [DONE]\n\n'] },
  'tool-call': { events: [sse(ROLE), sse(chunk({ tool_calls: [{ index: 0, ...CALL }] })), sse(chunk({}, 'tool_calls')), 'data: [DONE]\n\n'] },
  'empty-stop': { events: [sse(ROLE), sse(chunk({}, 'stop')), 'data: [DONE]\n\n'] },
};

/* opts.plain: what the one-piece re-ask answers. opts.plainStatus: its HTTP status.
 * opts.delayMs: how long it takes. */
async function run(streamKind, reqBody, env = {}, opts = {}) {
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
        const s = STREAMS[streamKind];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (const e of s.events) res.write(e);
        if (s.drop) setTimeout(() => res.destroy(), 50);
        else res.end();
        return;
      }
      setTimeout(() => {
        res.writeHead(opts.plainStatus || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(opts.plainStatus ? { error: { message: 'host is down' } } : (opts.plain || PLAIN)));
      }, opts.delayMs || 0);
    });
  });
  const upstreamPort = await listen(upstream);
  let gw;
  try {
    gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${upstreamPort}`, ...env });
    const answer = await post(gw.port, reqBody);
    await new Promise((r) => setTimeout(r, 250));
    return { answer, asks, bodies, words: wordsOf(answer.text), frames: framesOf(answer.text), log: gw.log() };
  } finally {
    if (gw) gw.child.kill();
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
  }
}
const ON = { KADE_LIVE_REASK: '1' };
const plains = (asks) => asks.filter((a) => a === 'plain').length;

/* ------------------------------ the phone lane ------------------------------ */

test('phone, switch off (the default): a turn that dies wordless is delivered as the host sent it, and nothing is asked again', async () => {
  const { answer, asks, words, log } = await run('finish-error', phoneBody());
  assert.equal(answer.status, 200, log.slice(-800));
  assert.match(log, /PHONE turn -> live content passthrough/, 'the fake turn really rode the phone lane');
  assert.equal(plains(asks), 0);
  assert.equal(words, '');
  assert.equal(eventsOnly(answer.text), STREAMS['finish-error'].events.join('').trim());
});

test('phone, switch on: a stream that ends finish=error before any word is asked once more and the caller hears the words', async () => {
  const { answer, asks, words, frames, log } = await run('finish-error', phoneBody(), ON);
  assert.equal(answer.status, 200, log.slice(-800));
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(words, REPLY);
  assert.deepEqual(finishes(frames), ['stop'], 'the host\'s error mark never reaches the caller');
  assert.equal(doneCount(answer.text), 1, 'one end marker');
  assert.equal(usages(frames).length, 1, 'the re-ask is counted');
  assert.equal(usages(frames)[0].prompt_tokens, 30);
  assert.match(log, /phone-live stream died before its first word \(finish=error\)/);
  assert.match(log, /live re-ask \(phone-live\) usage: prompt=30 completion=20/);
});

test('phone, switch on: a connection that drops before any word is asked once more and the caller hears the words', async () => {
  const { asks, words, frames, answer } = await run('drop', phoneBody(), ON);
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(words, REPLY);
  assert.deepEqual(finishes(frames), ['stop']);
  assert.equal(doneCount(answer.text), 1);
});

test('phone, switch on: a healthy turn is byte for byte what it is with the switch off, and is never asked twice', async () => {
  const off = await run('healthy', phoneBody());
  const on = await run('healthy', phoneBody(), ON);
  assert.equal(plains(on.asks), 0);
  assert.equal(on.words, 'Forty minutes at three fifty.');
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
  assert.equal(eventsOnly(on.answer.text), STREAMS.healthy.events.join('').trim(), 'every event, in the host\'s order');
});

test('phone, switch on: a reply that got a word out and then died is NOT asked again (the caller already heard part of it)', async () => {
  const off = await run('half-then-error', phoneBody());
  const on = await run('half-then-error', phoneBody(), ON);
  assert.equal(plains(on.asks), 0);
  assert.equal(on.words, 'Forty min');
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
});

test('phone, switch on: a chunk of only white space is not a word; the turn is still asked again', async () => {
  const { asks, words } = await run('space-then-error', phoneBody(), ON);
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(words, REPLY);
});

test('phone, switch on: a tool-call turn passes through whole, the held opening chunk first', async () => {
  const off = await run('tool-call', phoneBody({ tools: TOOLS }));
  const on = await run('tool-call', phoneBody({ tools: TOOLS }), ON);
  assert.equal(plains(on.asks), 0);
  assert.equal(toolDeltas(on.frames).length, 1);
  assert.deepEqual(finishes(on.frames), ['tool_calls']);
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
});

test('phone, switch on: a turn that ends cleanly with no words (finish=stop) is not a dead stream and is left alone', async () => {
  const off = await run('empty-stop', phoneBody());
  const on = await run('empty-stop', phoneBody(), ON);
  assert.equal(plains(on.asks), 0);
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
});

test('phone, switch on: the re-ask answers with a tool call and the agent gets the call, not silence', async () => {
  const plain = { id: 'y', model: 'test/plain-model',
    choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [CALL] }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 300, completion_tokens: 200, total_tokens: 500 } };
  const { answer, asks, bodies, frames, words } = await run('finish-error', phoneBody({ tools: TOOLS }), ON, { plain });
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(bodies[1].tools.length, 1, 'the re-ask carries the tools');
  const calls = toolDeltas(frames);
  assert.equal(calls.length, 1, answer.text);
  assert.equal(calls[0].function.name, 'web_search');
  assert.equal(calls[0].function.arguments, CALL.function.arguments);
  assert.equal(words, '');
  assert.deepEqual(finishes(frames), ['tool_calls']);
  assert.equal(usages(frames)[0].prompt_tokens, 300);
  assert.equal(doneCount(answer.text), 1);
});

test('phone, switch on: a re-ask the host refuses is tried ONCE, and the caller gets exactly what the switch-off caller gets', async () => {
  const off = await run('finish-error', phoneBody());
  const on = await run('finish-error', phoneBody(), ON, { plainStatus: 503 });
  assert.equal(plains(on.asks), 1, 'one attempt, no overload retries on a live call');
  assert.equal(on.words, '');
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
  assert.equal(doneCount(on.answer.text), 1);
  assert.match(on.log, /live re-ask \(phone-live\) failed/);
});

test('phone, switch on: a re-ask that comes back empty changes nothing for the caller, and its usage is still logged', async () => {
  const plain = { id: 'y', model: 'test/plain-model', choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 300, completion_tokens: 7, total_tokens: 307 } };
  const off = await run('finish-error', phoneBody());
  const on = await run('finish-error', phoneBody(), ON, { plain });
  assert.equal(plains(on.asks), 1);
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
  assert.match(on.log, /live re-ask \(phone-live\) usage: prompt=300 completion=7/);
  assert.match(on.log, /phone-live re-ask came back empty/);
});

test('phone, switch on: a re-ask slower than the phone window is cut, once, and the turn ends as it would have', async () => {
  const off = await run('finish-error', phoneBody());
  const on = await run('finish-error', phoneBody(), { ...ON, KADE_PHONE_REASK_MS: '400' }, { delayMs: 3000 });
  assert.equal(plains(on.asks), 1, 'cut at the window and not tried again');
  assert.ok(on.answer.ms < 2500, `the caller was not kept waiting for the slow host (${on.answer.ms} ms)`);
  assert.equal(eventsOnly(on.answer.text), eventsOnly(off.answer.text));
});

test('phone: KADE_RETRY_TRUNCATED=0 switches the live re-ask off as well', async () => {
  const { asks, words } = await run('finish-error', phoneBody(), { ...ON, KADE_RETRY_TRUNCATED: '0' });
  assert.equal(plains(asks), 0);
  assert.equal(words, '');
});

/* --------------------------- the tool-shim-live lane --------------------------- */

const shimStream = (kind) => kind; // the same host behaviours; the gateway's lane differs by model
test('shim, switch off (the default): a turn that dies wordless ends empty and nothing is asked again', async () => {
  const { answer, asks, words, bodies, log } = await run(shimStream('finish-error'), shimBody());
  assert.equal(answer.status, 200, log.slice(-800));
  assert.match(log, /TOOL SHIM active/, 'the fake turn really rode the shim lane');
  assert.equal(bodies[0].tools, undefined, 'the host never sees a tools field on this lane');
  assert.equal(plains(asks), 0);
  assert.equal(words, '');
});

test('shim, switch on: finish=error before any word is asked once more; the words arrive and private <think> text does not', async () => {
  const plain = { ...PLAIN, model: SHIM_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: `<think>They want the time and the heat.</think>${REPLY}` }, finish_reason: 'stop' }] };
  const { answer, asks, words, frames, log } = await run('finish-error', shimBody(), ON, { plain });
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(words, REPLY);
  assert.doesNotMatch(answer.text, /They want the time/);
  assert.deepEqual(finishes(frames), ['stop']);
  assert.equal(doneCount(answer.text), 1);
  assert.equal(usages(frames).length, 1);
  assert.equal(usages(frames)[0].prompt_tokens, 30);
  assert.match(log, /shim-live stream died before its first word/);
});

test('shim, switch on: a dropped connection before any word is asked once more and the words arrive', async () => {
  const { asks, words, answer } = await run('drop', shimBody(), ON);
  assert.deepEqual(asks, ['stream', 'plain']);
  assert.equal(words, REPLY);
  assert.equal(doneCount(answer.text), 1);
});

test('shim, switch on: the re-ask answers with a written tool call and the agent gets a real tool call', async () => {
  const plain = { ...PLAIN, model: SHIM_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content: '<tool_call>{"name":"web_search","arguments":{"q":"pie baking time"}}</tool_call>' }, finish_reason: 'stop' }] };
  const { answer, asks, frames, words } = await run('finish-error', shimBody(), ON, { plain });
  assert.deepEqual(asks, ['stream', 'plain']);
  const calls = toolDeltas(frames);
  assert.equal(calls.length, 1, answer.text);
  assert.equal(calls[0].function.name, 'web_search');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { q: 'pie baking time' });
  assert.equal(words, '');
  assert.doesNotMatch(answer.text, /<tool_call>/, 'the written form never reaches the client');
  assert.deepEqual(finishes(frames), ['tool_calls']);
  assert.equal(doneCount(answer.text), 1);
});

test('shim, switch on: a healthy turn is what it is with the switch off and is never asked twice', async () => {
  const off = await run('healthy', shimBody());
  const on = await run('healthy', shimBody(), ON);
  assert.equal(plains(on.asks), 0);
  assert.equal(on.words, 'Forty minutes at three fifty.');
  assert.equal(on.words, off.words);
  assert.deepEqual(finishes(on.frames), finishes(off.frames));
});

test('shim, switch on: a half-written reply is not asked again here (the client already has its first words)', async () => {
  const { asks, words } = await run('half-then-error', shimBody(), ON);
  assert.equal(plains(asks), 0);
  assert.equal(words, 'Forty min');
});

test('shim, switch on: a re-ask the host refuses is tried once and the turn ends as it did before, with one end marker', async () => {
  const off = await run('finish-error', shimBody());
  const on = await run('finish-error', shimBody(), ON, { plainStatus: 503 });
  assert.equal(plains(on.asks), 1);
  assert.equal(on.words, '');
  assert.deepEqual(finishes(on.frames), finishes(off.frames));
  assert.equal(doneCount(on.answer.text), 1);
});
