'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { realCostOf, sumUsage, costNote } = require('./usage-cost');

// Shape copied from a saved non-BYOK OpenRouter reply (Pluto blind gate,
// google/gemini-2.5-flash-lite, Sep 25 2026): upstream restates cost.
const plain = () => ({
  prompt_tokens: 11722, completion_tokens: 110, total_tokens: 11832,
  cost: 0.0125646, is_byok: false,
  cost_details: { upstream_inference_cost: 0.0125646, upstream_inference_prompt_cost: 0.012, upstream_inference_completions_cost: 0.0005646 },
});
// A BYOK reply: OpenRouter's fee in cost, Google's bill in upstream.
const byok = () => ({
  prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
  cost: 0, is_byok: true,
  cost_details: { upstream_inference_cost: 0.0004, upstream_inference_prompt_cost: 0.0001, upstream_inference_completions_cost: 0.0003 },
});

test('a plain OpenRouter call costs its cost; the restated upstream is not added', () => {
  assert.equal(realCostOf(plain()), 0.0125646);
});

test('a BYOK call costs the fee plus what the provider charged', () => {
  assert.equal(realCostOf(byok()), 0.0004);
  assert.equal(Math.round(realCostOf({ ...byok(), cost: 0.00002 }) * 1e8), 42000);
});

test('no price named (Moonshot, Z.AI direct) is null, never 0', () => {
  assert.equal(realCostOf({ prompt_tokens: 10, completion_tokens: 5 }), null);
  assert.equal(realCostOf(null), null);
});

test('one side missing passes the other through untouched', () => {
  const u = byok();
  assert.strictEqual(sumUsage(u, null), u);
  assert.strictEqual(sumUsage(null, u), u);
  assert.equal(sumUsage(null, null), null);
});

test('merging two plain calls keeps the cost and does not double it', () => {
  const m = sumUsage(plain(), plain());
  assert.equal(m.total_tokens, 23664);
  assert.equal(m.cost, 0.0251292);
  assert.equal(m.is_byok, false);
  assert.equal(m.cost_details.upstream_inference_cost, null);
  assert.equal(realCostOf(m), 0.0251292);
  // Even a biller that adds the two without checking is_byok reads it right.
  assert.equal(m.cost + (m.cost_details.upstream_inference_cost || 0), 0.0251292);
});

test('merging a BYOK call with a plain one counts each dollar once', () => {
  const m = sumUsage(byok(), plain());
  assert.equal(m.is_byok, true);
  assert.equal(m.cost, 0.0125646);
  assert.equal(m.cost_details.upstream_inference_cost, 0.0004);
  assert.equal(m.cost_details.upstream_inference_completions_cost, 0.0003);
  assert.equal(Math.round(realCostOf(m) * 1e7), Math.round(0.0129646 * 1e7));
});

test('a merge with a side that named no price drops the cost pair', () => {
  const m = sumUsage(byok(), { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 });
  assert.equal(m.total_tokens, 1270);
  assert.equal('cost' in m, false);
  assert.equal('cost_details' in m, false);
  assert.equal(realCostOf(m), null);
});

test('merging never changes the caller\'s objects', () => {
  const a = plain(), b = byok();
  sumUsage(a, b);
  assert.deepEqual(a, plain());
  assert.deepEqual(b, byok());
});

test('the slop rewrite hands back usage that still carries both calls\' cost', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const start = source.indexOf('async function detectAndRewrite('), end = source.indexOf('\n// -- fake single-shot SSE', start);
  const context = { writingDeskFor: () => '', WRITING_STYLE_NOTE: 'craft', console: { log() {}, warn() {}, error() {} },
    REPLY_FOCUS_ON: false, COHERENCE_ON: false, SLOP_REWRITE_MAX_CHARS: 10000, SLOP_VERIFY: false,
    scrubSearchArtifacts: (t) => t, normalizeVoiceTagTypos: (t) => t, isLyricBody: () => false, isSweptMachineBody: () => false,
    isMemoryKeeperShapedBody: () => false, KEEPER_OUT_CARVEOUT: true, stripContextReplay: (t) => t,
    protectSentinelTags: (t) => ({ text: t, tags: [] }), restoreSentinelTags: (t) => t,
    collectMatches: (t) => (t === 'Draft reply' ? [{ pattern: 'clean_tic' }] : []),
    rewritePass: async () => ({ text: 'Clean reply', usage: byok() }),
    sumUsage, slopStats: { record() {}, outcome() {} } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run=detectAndRewrite;', context);
  const result = { choices: [{ message: { content: 'Draft reply' } }], usage: plain() };
  await context.run(result, {});
  assert.equal(result.choices[0].message.content, 'Clean reply');
  assert.equal(result.usage.total_tokens, 13032);
  assert.equal(result.usage.cost, 0.0125646);
  assert.equal(result.usage.cost_details.upstream_inference_cost, 0.0004);
  assert.equal(Math.round(realCostOf(result.usage) * 1e7), Math.round(0.0129646 * 1e7));
});

test('the log note shows the real cost, and the split on BYOK', () => {
  assert.equal(costNote(plain()), ' cost=$0.012565');
  assert.equal(costNote(byok()), ' cost=$0.000400 (BYOK: OpenRouter fee $0.000000 + provider $0.000400)');
  assert.equal(costNote({ prompt_tokens: 1 }), '');
  assert.equal(costNote(null), '');
});
