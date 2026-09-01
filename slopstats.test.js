'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeSlopStats, KEEP_DAYS } = require('./slopstats');

test('counts trips per category per UTC day and strips the blocklist prefix', () => {
  let t = Date.parse('2026-09-01T12:00:00Z');
  const s = makeSlopStats(() => t);
  s.record([{ pattern: 'blocklist:disclaimer_hedge' }, { pattern: 'blocklist:disclaimer_hedge' }, { pattern: 'over_hedging' }], 'rewrite_clean');
  const snap = s.snapshot();
  assert.equal(snap.today.replies, 1);
  assert.equal(snap.today.trips, 3);
  assert.deepEqual(snap.days['2026-09-01'].trips, { disclaimer_hedge: 2, over_hedging: 1 });
  assert.deepEqual(snap.days['2026-09-01'].outcomes, { rewrite_clean: 1 });
  assert.equal(snap.resetsOnDeploy, true);
  assert.equal(typeof snap.countingSince, 'string');
});

test('yesterday is the previous UTC day and the spoken line names it', () => {
  let t = Date.parse('2026-09-01T23:30:00Z');
  const s = makeSlopStats(() => t);
  s.record([{ pattern: 'blocklist:assistant_register' }], 'longform_kept');
  t = Date.parse('2026-09-02T01:00:00Z');
  const snap = s.snapshot();
  assert.equal(snap.yesterday.date, '2026-09-01');
  assert.equal(snap.yesterday.replies, 1);
  assert.equal(snap.today.replies, 0);
  assert.match(snap.spoken, /yesterday: 1 reply tripped \(assistant register 1x\)/);
  assert.match(snap.spoken, /1 long-form kept/);
});

test('a fresh counter says it is partial and has not tripped', () => {
  let t = Date.parse('2026-09-01T12:00:00Z');
  const s = makeSlopStats(() => t);
  t += 2 * 36e5;
  const snap = s.snapshot();
  assert.match(snap.spoken, /only been running 2 hours/);
  assert.match(snap.spoken, /has not tripped/);
});

test('outcome() attaches to the current day without adding a reply', () => {
  const t = Date.parse('2026-09-01T12:00:00Z');
  const s = makeSlopStats(() => t);
  s.record([{ pattern: 'x' }]);
  s.outcome('second_pass');
  const d = s.snapshot().days['2026-09-01'];
  assert.equal(d.replies, 1);
  assert.deepEqual(d.outcomes, { second_pass: 1 });
});

test('keeps at most KEEP_DAYS days', () => {
  let t = Date.parse('2026-08-01T12:00:00Z');
  const s = makeSlopStats(() => t);
  for (let i = 0; i < KEEP_DAYS + 5; i++) {
    s.record([{ pattern: 'x' }]);
    t += 864e5;
  }
  assert.equal(Object.keys(s.snapshot().days).length, KEEP_DAYS);
});
