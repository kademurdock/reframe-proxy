'use strict';
/* Oct 16 2026: MiMo speed fixes. The router's quick vote rides instant on MiMo
 * (KADE_MIMO_QUICK=low restores thinking), and the app's voice-message header no
 * longer reaches the think classifier. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');

const SOURCE = fs.readFileSync(require.resolve('./server'), 'utf8');

// The exact header the fork prepends to transcribed voice messages
// (packages/api/src/utils/speech.ts, Oct 2026).
const HEADER = '[Message source: voice message transcribed to text, possibly edited or mixed with typing. Names, punctuation and repeated words may be transcription errors. Use the intended meaning and established names when clear; ask only when ambiguity affects the answer. This is text from a recording, not a live call or access to the speaker’s audio, tone or surroundings.]';

function sliceFn(name, nextMarker) {
  const start = SOURCE.indexOf(name);
  assert.ok(start >= 0, `${name} present`);
  const end = SOURCE.indexOf(nextMarker, start + name.length);
  return SOURCE.slice(start, end);
}

test('the voice-message header is removed before the think classifier reads a message', () => {
  const reLine = SOURCE.match(/const SPEECH_SOURCE_RE = (\/.+\/gi);/);
  assert.ok(reLine, 'SPEECH_SOURCE_RE defined');
  const re = vm.runInNewContext(reLine[1]);
  const words = 'what time does the pharmacy close';
  const cleaned = `${HEADER}\n${words}`.replace(re, ' ').trim();
  assert.equal(cleaned, words);
  assert.ok(sliceFn('function autoThinkExcerpt(', '\n}\n').includes('.replace(SPEECH_SOURCE_RE'));
});

function runAutoThink({ tier, model = 'xiaomi/mimo-v2.6-pro', env = {} }) {
  const fn = sliceFn('async function maybeAutoThink(', '\nasync function ') ;
  const logs = [];
  const ctx = vm.createContext({
    console: { log: (s) => logs.push(String(s)) },
    process: { env },
    AUTO_DEEPTHINK: true,
    isReasoningModel: () => true,
    isPhoneTurn: () => false,
    autoThinkExcerpt: () => 'please compare these two plans for me in detail',
    instantRequested: () => false,
    stripContextReplay: (s) => s,
    autoThinkPersonText: () => '',
    stripInstantFromBody: (b) => b,
    autoThinkHeuristic: () => 'classify',
    classifyThinkTier: async () => tier,
    isMimoModel: (m) => /mimo-v2\.6/.test(m),
    isGlmModel: () => false,
    isXaiModel: () => false,
    autoThinkRunLen: () => 1,
    autoThinkPersonPick: () => ({ skipped: 0 }),
    excerptReceipt: (s) => s,
  });
  vm.runInContext(fn + '\nthis.run = maybeAutoThink;', ctx);
  const body = { model, messages: [{ role: 'system', content: 'x' }, { role: 'user', content: 'y' }] };
  return ctx.run(body, 'test').then((out) => ({ out, logs }));
}

test('a quick vote on MiMo answers without thinking', async () => {
  const { out, logs } = await runAutoThink({ tier: 'quick' });
  assert.notEqual(out.reasoning?.enabled, true);
  assert.ok(!['low', 'medium', 'high'].includes(out.reasoning?.effort));
  assert.ok(logs.some((l) => l.includes('MiMo: quick ridden as instant')));
});

test('KADE_MIMO_QUICK=low restores quick thinking on MiMo', async () => {
  const { out } = await runAutoThink({ tier: 'quick', env: { KADE_MIMO_QUICK: 'low' } });
  assert.equal(out.reasoning.enabled, true);
  assert.equal(out.reasoning.effort, 'low');
});

test('deep votes on MiMo still think, and other models keep quick', async () => {
  const deep = await runAutoThink({ tier: 'deep' });
  assert.equal(deep.out.reasoning.enabled, true);
  const other = await runAutoThink({ tier: 'quick', model: 'deepseek/deepseek-v4.1-flash' });
  assert.equal(other.out.reasoning.effort, 'low');
});
