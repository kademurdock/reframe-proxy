'use strict';
/* Part 141 (Sep 7 2026) — the CONTENT ECHO channel of driftSteerNote, on the
 * shapes from Amber A's cat chat: every reply re-explained the drain screen
 * and the diffuser whatever she had just said. */
const test = require('node:test');
const assert = require('node:assert');
const { driftSteerNote, _internals } = require('./cadence-drift');
const { contentEcho } = _internals;

const R1 = 'For the drain, since there is no threads, a snap-in or drop-in hair catcher that sits flat across the top is your best bet. ' +
  'Measure the drain opening first and grab one that fits snug. Take the one you already have with you so you can feel which new ones seat tighter. ' +
  'Feliway Classic diffuser is the one people use for urine marking and stress in multi-cat houses; give it two weeks before judging.';
const R2 = 'That makes sense about the choir. The pieces you actually get to share end up feeding the parts that need it. ' +
  'For the drain, ask for a shower drain hair catcher strainer or pet hair drain screen. ' +
  'Take the one you already have so you can feel which new ones seat tighter and do not shift when you press down. ' +
  'Feliway Classic diffuser is the one for marking and multi-cat stress; run it near where Kendrick hangs out and give it a couple weeks before judging.';
const FRESH = 'Do not use Drano on a rental with old pipes. The Zip-It is a stiff plastic strip with teeth along the edges; push it down, twist, pull it back slow. ' +
  'Hardware stores keep them by the plungers, three for a few bucks. Want the exact product names before you go?';

const body = (...assistants) => ({
  messages: [{ role: 'system', content: 'P' }, ...assistants.flatMap((a, i) => [{ role: 'user', content: 'turn ' + i }, { role: 'assistant', content: a }])],
});

test('a reply that re-explains the drain screen and the diffuser trips the channel', () => {
  const e = contentEcho([R1, R2]);
  assert.ok(e, 'no echo found');
  assert.ok(e.hits >= 2, 'expected at least two restated sentences, got ' + e.hits);
  assert.ok(e.topics.length >= 1);
  const note = driftSteerNote(body(R1, R2));
  assert.match(note, /Repetition note/);
  assert.match(note, /Do not restate earlier advice/);
});

test('a genuinely new answer after the same history is left alone', () => {
  assert.strictEqual(contentEcho([R1, R2, FRESH]), null);
  const note = driftSteerNote(body(R1, R2, FRESH));
  assert.ok(!/Repetition note/.test(note), note);
});

test('one shared sentence is a callback, not a recap', () => {
  const one = 'Totally different topic here, the honey thing is mostly a myth and the pollen rides the wind. ' +
    'Take the one you already have with you so you can feel which new ones seat tighter.';
  assert.strictEqual(contentEcho([R1, one]), null);
});

test('short history or short replies never trip', () => {
  assert.strictEqual(contentEcho([R1]), null);
  assert.strictEqual(contentEcho(['ok.', 'ok.']), null);
});

test('the topic words name what to drop, so the model knows', () => {
  const e = contentEcho([R1, R2]);
  const joined = e.topics.join(' ');
  assert.ok(/drain|feliway|diffuser|catcher|seat|tighter/.test(joined), joined);
});
