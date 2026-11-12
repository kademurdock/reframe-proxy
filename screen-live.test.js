'use strict';
/* Nov 12 2026 (gateway audit GW-6): a typed turn the person HEARS as it arrives can take the phone lane's live
 * passthrough. KADE_SCREEN_LIVE: unset or off (default) = nothing changes; asked = only a body with
 * kade_live: true; all = every eligible turn (not to be used: it also sends rooms and background turns live).
 * Only a turn proved not to think goes live. kade_live is always taken off the body before a host sees it.
 * Boots the real gateway against a fake host on 127.0.0.1 and reads what a client would read. Nothing paid. */
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
const chunk = (model, delta, finish = null) => sse({ id: 'x', model, choices: [{ index: 0, delta, finish_reason: finish }] });
const FIRST = 'The short answer is yes, you can.';
const REST = ' Bring a jacket though, because the evening gets cold out by the lake and the wind picks up after dark.';
const RESCUED = 'Here is the answer you asked for, said plainly.';

/* The fake host. The last user message picks what a STREAMED call does; a one-piece call (the re-ask or the
 * rescue) always answers with RESCUED. Every body is recorded. */
async function fakeHost() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      bodies.push(body);
      const model = body.model || 'test/plain-model';
      const last = String(((body.messages || []).filter((m) => m.role === 'user').pop() || {}).content || '');
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'r', model, choices: [{ index: 0, message: { role: 'assistant', content: RESCUED }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (/dies wordless/.test(last)) {
        res.write(chunk(model, { role: 'assistant', content: '' }));
        res.end(chunk(model, {}, 'error') + 'data: [DONE]\n\n');
      } else if (/thinks only/.test(last)) {
        res.write(chunk(model, { role: 'assistant', reasoning: 'Let me think about the lake and the weather tonight.' }));
        res.end(chunk(model, {}, 'length') + 'data: [DONE]\n\n');
      } else if (/blocked/.test(last)) {
        res.write(chunk(model, { role: 'assistant', content: '' }));
        res.end(chunk(model, {}, 'sensitive') + 'data: [DONE]\n\n');
      } else if (/use the tool/.test(last)) {
        res.write(chunk(model, { role: 'assistant', content: 'Let me check that.' }));
        res.write(chunk(model, { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q":"lake weather"}' } }] }));
        res.end(chunk(model, {}, 'tool_calls') + 'data: [DONE]\n\n');
      } else {
        res.write(chunk(model, { role: 'assistant', content: FIRST }));
        await new Promise((r) => setTimeout(r, 1500));
        res.write(chunk(model, { content: REST }));
        res.end(chunk(model, {}, 'stop') + 'data: [DONE]\n\n');
      }
    });
  });
  const port = await listen(server);
  return { port, bodies, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}

/* A streamed turn. Returns the raw text, when the first content reached the client and the total time. */
function ask(port, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ stream: true, ...body });
    const t0 = Date.now();
    let firstContentAt = null;
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret' } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; if (firstContentAt === null && /"content":"[^"]/.test(text)) firstContentAt = Date.now() - t0; });
      res.on('end', () => resolve({ text, firstContentAt, ms: Date.now() - t0 }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('no answer in 60 s')));
    req.end(data);
  });
}
const msgs = (text) => [{ role: 'system', content: 'You are a warm friend.' }, { role: 'user', content: text }];
const dones = (text) => text.split('data: [DONE]').length - 1;
const words = (text) => text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => {
  try { const d = JSON.parse(l.slice(6)); return (d.choices && d.choices[0] && d.choices[0].delta && d.choices[0].delta.content) || ''; } catch { return ''; }
}).join('');

test('asked: a kade_live turn streams its first sentence at once; the flag never reaches a host', async (t) => {
  const host = await fakeHost();
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); await host.close(); });

  const live = await ask(gw.port, { model: 'test/plain-model', messages: msgs('Can I walk to the lake tonight?'), kade_live: true });
  assert.ok(live.firstContentAt !== null, gw.log().slice(-1500));
  assert.ok(live.firstContentAt < live.ms - 1000, `first words at ${live.firstContentAt} ms of ${live.ms} ms`);
  assert.equal(words(live.text), FIRST + REST);
  assert.equal(dones(live.text), 1);
  assert.match(gw.log(), /SCREEN turn -> live content passthrough/);
  assert.equal(host.bodies.length, 1, 'one host request');

  const before = host.bodies.length;
  const buffered = await ask(gw.port, { model: 'test/plain-model', messages: msgs('Can I walk to the lake tonight?') });
  assert.ok(buffered.firstContentAt >= 1400, `no flag: buffered, first words at ${buffered.firstContentAt} ms`);
  assert.ok(words(buffered.text).includes('jacket'));
  assert.ok(host.bodies.length > before);
  for (const b of host.bodies) assert.equal(Object.hasOwn(b, 'kade_live'), false, 'no host body carries kade_live');
});

test('asked: a turn that may think stays buffered', async (t) => {
  const host = await fakeHost();
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); await host.close(); });
  const cases = [
    { model: 'xiaomi/mimo-v2.6-pro', reasoning: { effort: 'high' } },
    { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: true } },
    { model: 'deepseek/deepseek-v4.1-flash', reasoning_effort: 'medium' },
    { model: 'test/plain-model', kade_think_deadline_ms: 20000 },
    { model: 'test/plain-model', response_format: { type: 'json_object' } },
  ];
  for (const c of cases) {
    const r = await ask(gw.port, { ...c, messages: msgs('Can I walk to the lake tonight?'), kade_live: true });
    assert.ok(r.firstContentAt === null || r.firstContentAt >= 1400, `${JSON.stringify(c)}: first words at ${r.firstContentAt} ms`);
  }
  assert.doesNotMatch(gw.log(), /SCREEN turn -> live content passthrough/);
  for (const b of host.bodies) assert.equal(Object.hasOwn(b, 'kade_live'), false);
});

test('asked: MiMo with thinking proved off goes live', async (t) => {
  const host = await fakeHost();
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); await host.close(); });
  const r = await ask(gw.port, { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, messages: msgs('Can I walk to the lake tonight?'), kade_live: true });
  assert.ok(r.firstContentAt !== null && r.firstContentAt < r.ms - 1000, `first words at ${r.firstContentAt} of ${r.ms} ms\n${gw.log().slice(-1500)}`);
  assert.match(gw.log(), /SCREEN turn -> live content passthrough/);
  const sent = host.bodies[host.bodies.length - 1];
  assert.equal(sent.reasoning && sent.reasoning.enabled, false);
});

test('asked: the silence guards still answer a live turn that produced no word, with one [DONE]', async (t) => {
  const host = await fakeHost();
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); await host.close(); });
  const died = await ask(gw.port, { model: 'test/plain-model', messages: msgs('This one dies wordless.'), kade_live: true });
  assert.equal(words(died.text), RESCUED, gw.log().slice(-1500));
  assert.equal(dones(died.text), 1);
  assert.match(gw.log(), /screen-live stream died before its first word/);

  const thought = await ask(gw.port, { model: 'xiaomi/mimo-v2.6-pro', reasoning: { enabled: false }, messages: msgs('This one thinks only.'), kade_live: true });
  assert.ok(words(thought.text).length > 0, `the rescue spoke: ${thought.text.slice(-400)}`);
  assert.equal(dones(thought.text), 1);

  const blocked = await ask(gw.port, { model: 'test/plain-model', messages: msgs('This one is blocked.'), kade_live: true });
  assert.ok(words(blocked.text).length > 0, `the notice arrived: ${blocked.text.slice(-400)}`);
  assert.equal(dones(blocked.text), 1);
});

test('asked: a tool turn gets its words and its call, once each, in order', async (t) => {
  const host = await fakeHost();
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_SCREEN_LIVE: 'asked', KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); await host.close(); });
  const r = await ask(gw.port, { model: 'test/plain-model', messages: msgs('Please use the tool for the lake weather.'), kade_live: true,
    tools: [{ type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { q: { type: 'string' } } } } }] });
  const at = r.text.indexOf('Let me check that.');
  const call = r.text.indexOf('"tool_calls"');
  assert.ok(at >= 0 && call > at, r.text.slice(0, 800));
  assert.equal(r.text.split('Let me check that.').length - 1, 1);
  assert.equal(r.text.split('call_1').length - 1, 1);
  assert.equal(dones(r.text), 1);
});

test('unset (the default): the flag is taken off and the turn is buffered as before', async (t) => {
  const host = await fakeHost();
  const gw = await boot({ OPENROUTER_BASE: `http://127.0.0.1:${host.port}`, KADE_JEV: '0' });
  t.after(async () => { gw.child.kill(); await host.close(); });
  const r = await ask(gw.port, { model: 'test/plain-model', messages: msgs('Can I walk to the lake tonight?'), kade_live: true });
  assert.ok(r.firstContentAt >= 1400, `buffered: first words at ${r.firstContentAt} ms`);
  assert.doesNotMatch(gw.log(), /SCREEN turn/);
  for (const b of host.bodies) assert.equal(Object.hasOwn(b, 'kade_live'), false);
});
