'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectEchoGuard, detectPersonaParrot, detectUserEcho, exampleLinesFromSystem, echoShare } = require('./echo-guard');

/* An invented persona with the same example grammar Kiana's carries. */
const PERSONA = [
  '# SOMEBODY — SYSTEM PROMPT',
  '## 6. THE SOUND OF YOU',
  'Real exchanges, the register to hit. Never reuse these exact lines.',
  '',
  'Them: which is better, the lake or the river',
  'You: %%%tongue click%%% The lake is the picture. The river is the story. You asked which is better and that is like asking whether the boat or the water is better. %%%reset%%% Pick one for a Tuesday and I will argue the other.',
  '',
  'Them: roast me, I bought a fourth lawn chair',
  'You: %%%dry and delighted%%% Four. You run a small regional airport for backsides. Which one is the flagship?',
  '',
  'Them: hey',
  'You: Hey yourself. Slow day, or something brewing?',
  '',
  'And two at length, because quips alone leave you with no model.',
  '',
  'Them: my cousin has not called since the wedding',
  '',
  'You: %%%warm%%% Three weeks is long for y\'all. Okay, first thing. Do you actually know what it is about, or are you guessing?',
  'Those are different problems and the second one is cheaper to fix.',
  '',
  '## 7. BEING USEFUL',
  'Answer the actual question first.',
].join('\n');

const body = (userText, extra = []) => ({
  messages: [{ role: 'system', content: PERSONA }, ...extra, { role: 'user', content: userText }],
});

test('example lines are lifted from every "You:" line, continuation included, tags off', () => {
  const lines = exampleLinesFromSystem(PERSONA);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^The lake is the picture/);
  assert.doesNotMatch(lines[0], /%%%/);
  assert.match(lines[3], /cheaper to fix\.$/);
});

test('a reply that quotes a persona example line trips persona_parrot with the copied words named', () => {
  const reply = 'Ha. You asked me which is better and that is like asking whether the boat or the water is better. Pick one and I will take the other side.';
  const m = detectPersonaParrot(reply, PERSONA);
  assert.equal(m.length, 1);
  assert.equal(m[0].pattern, 'persona_parrot');
  assert.equal(m[0].kind, 'rewrite');
  assert.match(m[0].detail, /like asking whether the boat or the water is better/);
});

test('a bit reused with one noun swapped still trips on the shared run', () => {
  const reply = 'Four chairs. You run a small regional airport for frozen tater tots at this point.';
  const m = detectPersonaParrot(reply, PERSONA);
  assert.equal(m.length, 1);
  assert.match(m[0].detail, /small regional airport for/);
});

test('fresh words in the same register do not trip', () => {
  const reply = 'The lake wins on a Tuesday. The river wins when you want a story to tell later. Which one are you actually near?';
  assert.deepEqual(detectPersonaParrot(reply, PERSONA), []);
});

test('short greetings shared with an example are not a match (glue-only grams are skipped)', () => {
  assert.deepEqual(detectPersonaParrot('Hey yourself. What is going on with you today?', PERSONA), []);
});

test('no example lines means no parrot channel at all', () => {
  assert.deepEqual(detectPersonaParrot('anything at all here about the boat or the water', 'You are a helpful assistant.'), []);
});

test('a reply that restates the person\'s message nearly word for word trips user_echo', () => {
  const human = 'I guess the marshmallow is supposed to substitute for the cream filling but the buttercream would have been plenty.';
  const reply = 'Yeah. The marshmallow is supposed to substitute for the cream filling and the buttercream would have been plenty. Cosmic brownie is the safer pick this week.';
  const m = detectUserEcho(reply, human);
  assert.equal(m.length, 1);
  assert.equal(m[0].pattern, 'user_echo');
  assert.match(m[0].detail, /^The marshmallow is supposed/);
});

test('a reaction plus new information is not an echo', () => {
  const human = 'I guess the marshmallow is supposed to substitute for the cream filling but the buttercream would have been plenty.';
  const reply = 'Fair. They reach for marshmallow because it pipes easy and photographs fluffy, and the original never had any. Cosmic brownie if you land near one.';
  assert.deepEqual(detectUserEcho(reply, human), []);
});

test('a clarifying question and a deliberate quote are allowed to carry her words', () => {
  const human = 'my landlord said the deposit is gone because the carpet was already stained when we moved in';
  const reply = 'Wait, the deposit is gone because the carpet was already stained when you moved in? "already stained when we moved in" is his exact claim, and it is the part to fight.';
  assert.deepEqual(detectUserEcho(reply, human), []);
});

test('a request to repeat is never an echo', () => {
  const human = 'say that again, the part about the deposit and the carpet being stained when we moved in';
  const reply = 'The deposit and the carpet being stained when you moved in is the whole case.';
  assert.deepEqual(detectUserEcho(reply, human), []);
});

test('short user messages cannot be echoed', () => {
  assert.deepEqual(detectUserEcho('Fair enough, the lineup lets you pick.', 'fair enough'), []);
});

test('detectEchoGuard runs both channels off the request body and the human text', () => {
  const human = 'my uncle bought a small regional airport for backsides, roast him';
  const reply = 'He bought a small regional airport for backsides, so roast him I will. That is like asking whether the boat or the water is better.';
  const m = detectEchoGuard(reply, body(human), { humanText: human });
  const patterns = m.map((x) => x.pattern).sort();
  assert.deepEqual(patterns, ['persona_parrot', 'persona_parrot', 'user_echo']);
});

test('echoShare is a measurement, null when the person said too little', () => {
  assert.equal(echoShare('anything', 'hey'), null);
  const s = echoShare('The carpet stain and the deposit are one fight, not two.', 'my landlord kept the deposit over a carpet stain from before we moved in');
  assert.ok(s > 0 && s <= 1);
});
