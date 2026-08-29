/* callinstant.test.js — Aug 28 2026.
 * "Calls should be on instant by default at the beginning of the call unless
 * someone changes it. Just the voice chats and phone lanes."
 *
 * Source-level guard: the call-instant branch must sit AHEAD of the
 * classifier (so a call never pays the ~1.2s wait) and BEHIND the explicit
 * -choice guards (so "think hard", a fresh [DEEP THINK], an agent effort
 * setting and a fresh [INSTANT] all still win). Comment-stripped, because a
 * guard that matches its own documentation proves nothing.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const RAW = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const fn = SRC.slice(SRC.indexOf('async function maybeAutoThink'), SRC.indexOf('async function maybeAutoThink') + 4000);

test('a call turn short-circuits to instant', () => {
  assert.match(fn, /isCall && CALL_INSTANT/, 'the call-instant branch is missing');
  assert.match(fn, /effort: 'none'/, 'it must actually pin effort none');
});

test('it runs BEFORE the classifier, so a call never pays the wait', () => {
  assert.ok(fn.indexOf('isCall && CALL_INSTANT') < fn.indexOf('classifyThinkTier'),
    'the call branch must precede the classifier call');
});

test('every explicit choice still wins — the branch sits after all of them', () => {
  const callAt = fn.indexOf('isCall && CALL_INSTANT');
  for (const [what, needle] of [
    ['a real effort / enabled setting', "['low', 'medium', 'high'].includes(effort)"],
    ['a fresh [INSTANT] marker', 'if (forcedInstant)'],
    ['the title/summarizer shape', 'bare title/summarizer shape'],
  ]) {
    assert.ok(fn.indexOf(needle) > -1 && fn.indexOf(needle) < callAt,
      `${what} must be checked before the call default`);
  }
});

test('it is only calls — the typed lane keeps the full auto router', () => {
  assert.match(fn, /const isCall = isPhoneTurn\(body\)/);
  assert.match(fn, /autoThinkHeuristic\(excerpt\)/, 'the typed path must survive');
});

test('there is a kill switch, and it defaults ON', () => {
  assert.match(SRC, /KADE_CALL_INSTANT_DEFAULT !== '0'/);
});
