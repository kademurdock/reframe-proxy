'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { makeZaiMeter, costOf, rateFor } = require('./zaimeter');

test('flash is promo through Sep 9 and list from Sep 10; unknown glm overstates to the 5.3 row', () => {
  assert.deepEqual(rateFor('glm-5.3-flash', '2026-09-09'), [0.075, 0.25, 0.015]);
  assert.deepEqual(rateFor('z-ai/glm-5.3-flash', '2026-09-10'), [0.15, 0.5, 0.03]);
  assert.deepEqual(rateFor('glm-9-mystery', '2026-09-10'), [1.4, 4.4, 0.14]);
});

test('cost counts cached prompt at the cached rate', () => {
  const u = { prompt_tokens: 32000, completion_tokens: 600, prompt_tokens_details: { cached_tokens: 30000 } };
  const c = costOf('glm-5.3-flash', u, '2026-09-10');
  assert.equal(Math.round(c * 1e6), Math.round((2000 * 0.15 + 30000 * 0.03 + 600 * 0.5)));
});

test('the meter keeps per-day totals and trims old days', () => {
  let t = new Date('2026-09-05T10:00:00Z');
  const m = makeZaiMeter({ keepDays: 2, now: () => t });
  m.note('glm-5.3-flash', { prompt_tokens: 1e6, completion_tokens: 0 });
  t = new Date('2026-09-06T10:00:00Z'); m.note('glm-5.3', { prompt_tokens: 1e6, completion_tokens: 0 });
  t = new Date('2026-09-07T10:00:00Z'); m.note('glm-4.5-air', { prompt_tokens: 0, completion_tokens: 1e6 });
  const s = m.snapshot();
  assert.deepEqual(Object.keys(s.days), ['2026-09-06', '2026-09-07']);
  assert.equal(s.days['2026-09-06'].usd, 1.4);
  assert.equal(s.todayUSD, 1.1);
  assert.equal(s.days['2026-09-07'].calls, 1);
});
