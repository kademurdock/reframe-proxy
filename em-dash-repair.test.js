'use strict';
/* Sep 22 2026: the em-dash restatement rewrite had no repair to copy, so it
 * shipped the drumbeat intact. The guidance now carries a worked Before and
 * After, and the After must itself pass the same detector. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { detectSlop } = require('./slop-filter');

function guidance() {
  const s = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext(s.slice(s.indexOf('const PATTERN_GUIDANCE ='), s.indexOf('// Aug 10 2026 — HER STUCK TEMP CHAT')) + '\nthis.g = guidanceFor; this.prompt = buildRewriteSystemPrompt;', ctx);
  return ctx;
}

test('the em-dash restatement guidance carries a repair, not just a name', () => {
  const g = guidance().g('em_dash_restatement');
  assert.match(g, /Before: "[^"]+" After: "[^"]+"/);
  assert.match(g, /the run of parallel items has to go/);
});

test('the Before trips the detector and the After does not', () => {
  const g = guidance().g('em_dash_restatement');
  const before = g.match(/Before: "([^"]+)"/)[1];
  const after = g.match(/After: "([^"]+)"/)[1];
  const hit = (t) => detectSlop(t).matches.some((m) => m.pattern === 'em_dash_restatement');
  assert.equal(hit(before), true, 'the Before no longer shows the tic');
  assert.equal(hit(after), false, 'the After still carries the tic');
  assert.equal(detectSlop(after).matches.length, 0, 'the After trips some other detector');
});

test('the rewrite prompt hands the repair to the rewriter', () => {
  const ctx = guidance();
  const matches = detectSlop('It came out too bright — too much top, too much air, too much shine.').matches;
  const prompt = ctx.prompt(matches, false);
  assert.match(prompt, /After: "It came out too bright, with too much top end\."/);
});
