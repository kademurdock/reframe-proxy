'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  TALK_NOTE, EXPLAIN_NOTE, registerMode, talkRegisterNoteFor,
  TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL,
  TRUST_LISTENER_NOTE, trustListenerNoteFor,
} = require('./talk-register');
const { detectSlop } = require('./slop-filter');

// Both texts of each note (KADE_CASUAL_HOUSE on and off) and the trust note
// that rides before talk: every one is held to the same rules.
const ALL_NOTES = [TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL, TRUST_LISTENER_NOTE];

const body = (said, extra = {}) => ({ model: 'deepseek/deepseek-v4.1-flash', messages: [
  { role: 'system', content: 'persona' },
  { role: 'user', content: said },
], ...extra });

test('casual turns get the talk note', () => {
  for (const said of [
    'lol he did it AGAIN',
    'my cat knocked the plant over this morning',
    'why would he say that to her though',
    'how was your day',
    'I think UBI is a pipe dream honestly',
    'Mylo is back home from the vet',
    // her complaints about length are conversation (the A/B's misroute)
    'You gave me an essay about not giving an essay',
    'why is everything an essay with you lol',
    'that report card was rough',
  ]) {
    assert.strictEqual(registerMode(body(said)), 'talk', said);
    assert.strictEqual(talkRegisterNoteFor(body(said), {}), TALK_NOTE, said);
  }
});

test('plain requests for depth get the explain note', () => {
  for (const said of [
    'can you explain how a disk stores data',
    'walk me through setting up the router',
    'how does a heat pump work',
    'how do I get the library to play in the background',
    "what's the difference between a cassette and a reel to reel",
    'give me the five-minute version of the Civil War',
    'write me a poem about my dog',
    'can you look it up for me',
    'pros and cons of moving to Springfield',
    'summarize this article for me',
    'give me a rundown of the new tax rules',
    'write me an essay on the Ozarks',
    'the history of KWTO radio',
  ]) {
    assert.strictEqual(registerMode(body(said)), 'explain', said);
    assert.strictEqual(talkRegisterNoteFor(body(said), {}), EXPLAIN_NOTE, said);
  }
});

test('the latest human message decides, not older ones or pasted blocks', () => {
  const b = { messages: [
    { role: 'user', content: 'explain quantum computing' },
    { role: 'assistant', content: 'Sure...' },
    { role: 'user', content: 'ha, okay that was a lot' },
  ] };
  assert.strictEqual(registerMode(b), 'talk');
  assert.strictEqual(registerMode(body('look at this ```the manual says explain the steps```')), 'talk');
  assert.strictEqual(registerMode(body([{ type: 'text', text: 'teach me to knit' }])), 'explain');
});

test('kill switch, structured output and odd bodies', () => {
  assert.strictEqual(talkRegisterNoteFor(body('hey'), { KADE_TALK_REGISTER: '0' }), '');
  assert.strictEqual(talkRegisterNoteFor(body('hey', { response_format: { type: 'json_object' } }), {}), '');
  assert.strictEqual(talkRegisterNoteFor(null, {}), '');
  assert.strictEqual(talkRegisterNoteFor({}, {}), TALK_NOTE);
});

test('the notes read clean on the platform\'s own detector (never demonstrate a banned shape)', () => {
  for (const note of ALL_NOTES) {
    const found = detectSlop(note).matches.map(m => m.pattern + ': ' + m.text);
    assert.deepStrictEqual(found, [], found.join('; '));
  }
});

test('the notes quote none of the shapes they steer away from', () => {
  const quotedShapes = [
    /the part (?:where|that)/i, /here'?s the thing/i, /what matters/i, /the whole [a-z]+/i,
    /that'?s the [a-z]+\./i, /wearing [a-z]+'?s? clothes/i, /same [a-z]+, different/i,
    /isn'?t [a-z]+[.,] (?:it'?s|that'?s)/i, /not [a-z]+, but/i, /i don'?t know\./i, /i wanna know/i,
    // no contrast-by-denial in the note's own sentences either (", not X" / "never in X")
    /, not (?:a |an |the )?[a-z]+/i, /\bnever in\b/i,
    /"[^"]+"/, /“[^”]+”/,
  ];
  for (const note of ALL_NOTES) {
    for (const re of quotedShapes) assert.ok(!re.test(note), re + ' in note: ' + note.slice(0, 40));
  }
});

test('the notes stay short (a long note is the thing it warns against)', () => {
  const words = note => note.trim().split(/\s+/).length;
  for (const note of [TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL]) {
    assert.ok(words(note) <= 170, 'talk note words: ' + words(note));
  }
  for (const note of [EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL]) {
    assert.ok(words(note) <= 90, 'explain note words: ' + words(note));
  }
});

test('the note rides LAST in the tail, after the conversation guidance and the trust note', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('talkRegisterNoteFor(body)') && l.includes('guidance.conversation'));
  assert.ok(line, 'tail line found');
  assert.ok(/guidance\.conversation : ''\) \+ trustListenerNoteFor\(body\) \+ talkRegisterNoteFor\(body\) \}\]/.test(line),
    'trust rides right before the talk note, and the talk note is the final piece');
});

test('trust the listener rides only with the casual house, only where the talk note rides', () => {
  const on = { KADE_CASUAL_HOUSE: '1' };
  const off = { KADE_CASUAL_HOUSE: '0' };
  for (const said of ['lol he did it AGAIN', 'how was your day', 'You gave me an essay about not giving an essay']) {
    assert.strictEqual(trustListenerNoteFor(body(said), on), TRUST_LISTENER_NOTE, said);
    assert.strictEqual(talkRegisterNoteFor(body(said), on), TALK_NOTE_CASUAL, said);
    assert.strictEqual(trustListenerNoteFor(body(said), off), '', said);
    assert.strictEqual(talkRegisterNoteFor(body(said), off), TALK_NOTE_CLASSIC, said);
  }
  for (const said of ['can you explain how a disk stores data', 'write me a poem about my dog', 'pros and cons of moving to Springfield']) {
    assert.strictEqual(trustListenerNoteFor(body(said), on), '', 'explain turns never get it: ' + said);
    assert.strictEqual(talkRegisterNoteFor(body(said), on), EXPLAIN_NOTE_CASUAL, said);
    assert.strictEqual(talkRegisterNoteFor(body(said), off), EXPLAIN_NOTE_CLASSIC, said);
  }
  assert.strictEqual(trustListenerNoteFor(body('hey'), { ...on, KADE_TALK_REGISTER: '0' }), '', 'no talk note, no trust note');
  assert.strictEqual(trustListenerNoteFor(body('hey', { response_format: { type: 'json_object' } }), on), '');
  assert.strictEqual(trustListenerNoteFor(null, on), '');
  assert.notStrictEqual(TALK_NOTE_CASUAL, TALK_NOTE_CLASSIC);
  assert.notStrictEqual(EXPLAIN_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC);
  assert.ok([TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL].includes(TALK_NOTE), 'the export is one of the two texts');
  assert.ok([EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL].includes(EXPLAIN_NOTE));
});
