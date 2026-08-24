'use strict';
/**
 * zaipulse.test.js — the two halves that must never be collapsed into one
 * light, plus the honesty rules the snapshot depends on.
 *
 * The shapes below are the real ones. Aug 23 2026, reframe's own logs:
 *   `ZAI FALLBACK ACTIVE (stream, status 429) -- retrying z-ai/glm-5.3 via
 *    OpenRouter. CHECK THE Z.AI BALANCE.`
 * Four of those fired that evening, twice falling through to OpenRouter, and
 * the log line told a session to go check a BALANCE when the status was 429 —
 * a throttle. That misdirection is what `moneyOrKey` vs `throttled` exists to
 * stop, so it gets a test.
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { makeZaiPulse, verdictFor } = require('./zaipulse');

test('no calls seen is NOT the same answer as healthy', () => {
  const p = makeZaiPulse();
  const s = p.snapshot();
  assert.equal(s.calls, 0);
  assert.match(s.verdict, /cannot say/);
  assert.doesNotMatch(s.verdict, /answering/);
});

test('a clean run reports answering', () => {
  const p = makeZaiPulse();
  for (let i = 0; i < 10; i++) p.note(200);
  const s = p.snapshot();
  assert.equal(s.ok, 10);
  assert.equal(s.refused, 0);
  assert.equal(s.recentRefusalRate, 0);
  assert.match(s.verdict, /answering/);
});

test('429 is a THROTTLE and must not send anyone to top up a balance', () => {
  const p = makeZaiPulse();
  for (let i = 0; i < 20; i++) p.note(200);
  p.note(429);
  const s = p.snapshot();
  assert.equal(s.throttled, 1);
  assert.equal(s.moneyOrKey, 0);
  assert.match(s.verdict, /throttle/i);
  assert.doesNotMatch(s.verdict, /CHECK THE Z\.AI BALANCE/);
});

test('402 IS money and says so loudly', () => {
  const p = makeZaiPulse();
  p.note(200);
  p.note(402);
  const s = p.snapshot();
  assert.equal(s.moneyOrKey, 1);
  assert.equal(s.throttled, 0);
  assert.match(s.verdict, /CHECK THE Z\.AI BALANCE AND THE KEY/);
});

test('401 and 403 count as key/money too — a dead credential is not a throttle', () => {
  for (const status of [401, 403]) {
    const p = makeZaiPulse();
    p.note(status);
    assert.equal(p.snapshot().moneyOrKey, 1, `status ${status}`);
    assert.equal(p.snapshot().throttled, 0, `status ${status}`);
  }
});

test('money beats throttle in the verdict when both are present', () => {
  const p = makeZaiPulse();
  p.note(429); p.note(429); p.note(402);
  const s = p.snapshot();
  assert.equal(s.throttled, 2);
  assert.equal(s.moneyOrKey, 1);
  assert.match(s.verdict, /CHECK THE Z\.AI BALANCE AND THE KEY/);
});

test('chronic throttling crosses into a warning; a single blip does not', () => {
  const blip = makeZaiPulse();
  for (let i = 0; i < 99; i++) blip.note(200);
  blip.note(429);
  assert.doesNotMatch(blip.snapshot().verdict, /⚠️/);

  const chronic = makeZaiPulse();
  for (let i = 0; i < 50; i++) { chronic.note(200); chronic.note(429); }
  const s = chronic.snapshot();
  assert.ok(s.recentRefusalRate >= 0.2, `rate was ${s.recentRefusalRate}`);
  assert.match(s.verdict, /⚠️ throttled/);
});

test('the rolling window forgets, so an old outage cannot read as a live one', () => {
  const p = makeZaiPulse({ window: 10 });
  for (let i = 0; i < 10; i++) p.note(429);
  assert.equal(p.snapshot().recentRefusalRate, 1);
  for (let i = 0; i < 10; i++) p.note(200);
  const s = p.snapshot();
  assert.equal(s.recentRefusalRate, 0, 'window should have rolled clean');
  // ...but the lifetime tally still remembers it happened.
  assert.equal(s.throttled, 10);
  assert.equal(s.byStatus[429], 10);
});

test('the snapshot always admits it resets on deploy and how old it is', () => {
  let clock = 1_000_000;
  const p = makeZaiPulse({ now: () => clock });
  p.note(200);
  clock += 45 * 60 * 1000;
  const s = p.snapshot();
  assert.equal(s.resetsOnDeploy, true);
  assert.equal(s.ageMinutes, 45);
  assert.ok(s.since, 'since must be present so a fresh boot is visible');
});

test('garbage in is ignored rather than counted as a success', () => {
  const p = makeZaiPulse();
  p.note(undefined); p.note(null); p.note('nonsense');
  assert.equal(p.snapshot().calls, 0);
});

test('verdictFor is pure and testable on its own', () => {
  assert.match(verdictFor({ calls: 0 }), /cannot say/);
  assert.match(verdictFor({ calls: 5, moneyOrKey: 1, throttled: 0, recentRefused: 1, recentLen: 5 }), /BALANCE/);
});
