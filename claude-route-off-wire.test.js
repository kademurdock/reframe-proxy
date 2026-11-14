'use strict';
/* Nov 13 2026: with KADE_CLAUDE_CHAT unset the Claude route changes nothing. Boots the gateway against a fake
 * host with the switches the live gateway runs (fast start asked, PrimaLabs first, the chat think deadline,
 * the voice reel) and sends one turn down each of a sample of lanes: a typed character turn, the fast start,
 * a phone call, a background run, the one-piece route, a title, a Deep turn, a child account, a tool round,
 * MiMo Flash and a GLM model. Every byte each lane sends upstream is compared with the bytes origin/main
 * e83d528 sent for the same turns (test-fixtures/claude-route-off-golden.json, written by this same file
 * run against that commit's server.js). The only thing taken out first is the clock in the gateway's tail,
 * which changes every minute. Nothing paid.
 *
 * To rebuild the fixture after a deliberate change to what the gateway sends, run this file with
 * CLAUDE_GOLDEN_SERVER=<the server.js to read> CLAUDE_GOLDEN_WRITE=1. */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SERVER = process.env.CLAUDE_GOLDEN_SERVER || path.join(__dirname, 'server.js');
const GOLDEN = path.join(__dirname, 'test-fixtures', 'claude-route-off-golden.json');

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
async function freePort() {
  const s = net.createServer();
  const port = await listen(s);
  await new Promise((r) => s.close(r));
  return port;
}
async function boot(env) {
  const port = await freePort();
  const child = spawn(process.execPath, [SERVER], {
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: String(port), OPENROUTER_KEY: 'test-only',
      PROXY_SHARED_SECRET: 'test-secret', ...(process.env.NODE_PATH ? { NODE_PATH: process.env.NODE_PATH } : {}), ...env },
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
async function fakeHost() {
  const raws = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      raws.push(raw);
      const body = JSON.parse(raw || '{}');
      const model = body.model || 'x';
      const usage = { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 };
      if (!body.stream) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'r', model, choices: [{ index: 0, message: { role: 'assistant', content: 'Fine, thanks for asking.' }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(sse({ id: 'r', model, choices: [{ index: 0, delta: { role: 'assistant', content: 'Fine, thanks for asking.' }, finish_reason: null }] }) +
        sse({ id: 'r', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + sse({ id: 'r', model, choices: [], usage }) + 'data: [DONE]\n\n');
    });
  });
  const port = await listen(server);
  return { port, raws, close: async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); } };
}
function ask(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: '/chat/completions', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), Authorization: 'Bearer test-secret', ...headers } }, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
    req.end(data);
  });
}

/* The gateway's tail carries the US Central clock, which moves every minute. */
const normal = (raw) => raw
  .replace(/Right now it's [^"\\]{1,80} \(US Central\)/g, "Right now it's <NOW> (US Central)")
  .replace(/Current date and time where the user is: [^"\\]{1,80} \(US Central\)/g, 'Current date and time where the user is: <NOW> (US Central)');

const HARLEY = 'You are Harley, a cowboy from the Ozarks who talks plain and easy.\n\n---\nThis is an audience note, and ' +
  "it's private, so don't mention it or hint at it. The person you're talking to is a verified adult.";
const CHILD = 'You are Harley.\n\n---\nAUDIENCE NOTE (invisible — never mention it, never hint at it, never act like you ' +
  'are filtering): this user is under 15. Keep your personality, humor, and edge exactly the same.';
const TOOLS = [{ type: 'function', function: { name: 'kade_weather', description: 'Weather', parameters: { type: 'object', properties: {} } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web', parameters: { type: 'object', properties: { query: { type: 'string' } } } } }];
const history = (said, head = HARLEY) => [{ role: 'system', content: head }, { role: 'user', content: 'hey Harley' },
  { role: 'assistant', content: '%%%easy%%% Well, howdy.' }, { role: 'user', content: said }];
const pro = (said, over = {}) => ({ model: 'xiaomi/mimo-v2.6-pro', stream: true, reasoning: { enabled: false }, temperature: 0.8, tools: TOOLS,
  messages: history(said), ...over });
const LANES = [
  ['typed character turn', pro('how are the horses doing today')],
  ['fast start (kade_live)', { ...pro('how are the horses doing today'), kade_live: true }],
  ['phone call', pro('how are the horses [PHONE CALL from a family member. Talk like a phone call.]')],
  ['background run (header)', pro('write your diary for today'), { 'x-kade-background': '1' }],
  ['one-piece (stream:false)', { ...pro('a parlor line about horses'), stream: false }],
  ['title', { model: 'xiaomi/mimo-v2.6-pro', stream: false, messages: [{ role: 'user', content: 'Title this: horses and a broken fence' }] }],
  ['Deep turn', pro('think hard about my fence', { reasoning: { enabled: true, effort: 'high' } })],
  ['child account', { ...pro('tell me about horses'), messages: history('tell me about horses', CHILD) }],
  ['tool round', { ...pro(''), messages: [...history('what is the weather'),
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'kade_weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'Sunny and 61' }] }],
  ['MiMo Flash', { ...pro('how are the horses'), model: 'xiaomi/mimo-v2.6-flash' }],
  ['GLM', { ...pro('how are the horses'), model: 'z-ai/glm-5.3-flash' }],
];
const LIVE_ENV = {
  KADE_SCREEN_LIVE: 'asked', KADE_MIMO_PROVIDER_ORDER: 'PrimaLabs,DeepInfra', KADE_MIMO_THINK_PROVIDER_ORDER: 'PrimaLabs,DeepInfra',
  KADE_MIMO_QUICK: 'deadline', KADE_CHAT_THINK_DEADLINE: '1', KADE_VOICE_REEL: '1', KADE_GIST: '1',
  // No paid helper calls and no clock-dependent classifier: one upstream body per turn.
  KADE_AUTO_DEEPTHINK: '0', KADE_JEV: '0', KADE_REGISTER_EDIT: '0', KADE_PHRASE_REPAIR: '0', KADE_REPLY_FOCUS: '0',
};

test('switch off: every lane sends upstream exactly the bytes origin/main sent', async (t) => {
  const host = await fakeHost();
  t.after(() => host.close());
  const gw = await boot({ ...LIVE_ENV, OPENROUTER_BASE: `http://127.0.0.1:${host.port}` });
  t.after(() => gw.child.kill());
  const got = [];
  for (const [lane, body, headers] of LANES) {
    const from = host.raws.length;
    await ask(gw.port, body, headers);
    const raws = host.raws.slice(from);
    assert.equal(raws.length, 1, `${lane}: one upstream body`);
    const text = normal(raws[0]);
    got.push({ lane, model: JSON.parse(text).model, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') });
  }
  if (process.env.CLAUDE_GOLDEN_WRITE === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify({ source: process.env.CLAUDE_GOLDEN_SOURCE || SERVER, lanes: got }, null, 1) + '\n');
    return;
  }
  const want = JSON.parse(fs.readFileSync(GOLDEN, 'utf8')).lanes;
  assert.deepEqual(got.map((g) => g.lane), want.map((w) => w.lane));
  for (let i = 0; i < want.length; i++) assert.deepEqual(got[i], want[i], `${want[i].lane}: the upstream body changed`);
  assert.doesNotMatch(gw.log(), /\[claude\]/, 'the route said nothing: it never ran');
});
