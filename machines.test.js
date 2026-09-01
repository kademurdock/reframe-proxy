'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  isMemorySummaryShapedBody,
  isDiaryRepairShapedBody,
  isPersonaWriterShapedBody,
  isSweptMachineBody,
} = require('./machines.js');

/* Transcribed from kadeMemorySummary.js's userContent, Part 112. */
const SUMMARY_BODY = {
  model: 'z-ai/glm-4.5-air',
  messages: [
    { role: 'system', content: 'You keep a SHORT running summary of what has been going on LATELY...' },
    { role: 'user', content: 'TODAY IS: Monday, August 31, 2026 (US Central). Convert every relative time reference to an absolute date.\n\nCHARACTER: Kiana\n\nPREVIOUS SUMMARY (may be empty):\n(none yet)\n\nLATEST CONVERSATION:\nUser: hey\nKiana: hey yourself\n\nWrite the updated running summary now.' },
  ],
};

/* Transcribed from diaryVoiceRepair.js's batch message. */
const REPAIR_BODY = {
  model: 'z-ai/glm-4.5-air',
  messages: [
    { role: 'system', content: 'You repair diary wording without changing facts...' },
    { role: 'user', content: 'Entries:\n\n1. [2026-08-24] User had a long day.\n\nReview them per your instructions.' },
  ],
};

test('summary lane is detected', () => {
  assert.equal(isMemorySummaryShapedBody(SUMMARY_BODY), true);
  assert.equal(isSweptMachineBody(SUMMARY_BODY), true);
});

test('repair lane is detected', () => {
  assert.equal(isDiaryRepairShapedBody(REPAIR_BODY), true);
  assert.equal(isSweptMachineBody(REPAIR_BODY), true);
});

test('a person QUOTING the summary prompt mid-conversation does not trip it', () => {
  const body = {
    messages: [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'lol the prompt says "Write the updated running summary now." isn\'t that funny? anyway how are you' },
    ],
  };
  assert.equal(isSweptMachineBody(body), false);
});

test('an ordinary persona turn does not trip it', () => {
  const body = {
    messages: [
      { role: 'system', content: 'persona' },
      { role: 'user', content: 'what should I make for dinner' },
    ],
  };
  assert.equal(isSweptMachineBody(body), false);
});

test('kill switch restores old behaviour', () => {
  process.env.KADE_MACHINE_CARVEOUTS = '0';
  assert.equal(isSweptMachineBody(SUMMARY_BODY), false);
  delete process.env.KADE_MACHINE_CARVEOUTS;
});

/* Transcribed from kadeCreateCharacter.js's write-persona userContent, Part 113. */
const PERSONA_BODY = {
  model: 'z-ai/glm-5.3-flash',
  messages: [
    { role: 'system', content: 'You write system prompts for characters on a blind-first chat platform...' },
    {
      role: 'user',
      content:
        "CHARACTER BRIEF (from the person building them):\nan ACT-based therapist that also borrows from other modalities when appropriate\n\nROUND: 1\n\nWrite the character's system prompt now.",
    },
  ],
};

test('persona writer lane is detected', () => {
  assert.equal(isPersonaWriterShapedBody(PERSONA_BODY), true);
  assert.equal(isSweptMachineBody(PERSONA_BODY), true);
});

test('a person QUOTING the persona-writer prompt does not trip it', () => {
  const body = {
    messages: [
      { role: 'system', content: 'persona' },
      {
        role: 'user',
        content:
          'i saw a prompt that said "Write the character\'s system prompt now." and CHARACTER BRIEF (from the person building them): lol. anyway, what is for dinner',
      },
    ],
  };
  assert.equal(isSweptMachineBody(body), false);
});

test('the persona writer is not carved out when the kill switch is off', () => {
  const prev = process.env.KADE_MACHINE_CARVEOUTS;
  process.env.KADE_MACHINE_CARVEOUTS = '0';
  assert.equal(isSweptMachineBody(PERSONA_BODY), false);
  if (prev === undefined) delete process.env.KADE_MACHINE_CARVEOUTS;
  else process.env.KADE_MACHINE_CARVEOUTS = prev;
});

/* PART 115 — the return-path half. server.js boots a listener on require, so
 * this asserts the wiring by reading the source: the swept-machine guard must
 * sit inside detectAndRewrite and BEFORE the bare-JSON probe, so a prose
 * persona draft or a relationship summary never reaches collectMatches. */
test('detectAndRewrite skips swept machine lanes before the JSON probe', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(require('node:path').join(__dirname, 'server.js'), 'utf8');
  const fn = src.indexOf('async function detectAndRewrite(');
  assert.ok(fn > 0, 'detectAndRewrite exists');
  const guard = src.indexOf('if (isSweptMachineBody(upstreamBody))', fn);
  const probe = src.indexOf('const jsonProbe = content.trim();', fn);
  const collect = src.indexOf('const matches = collectMatches(content, upstreamBody);', fn);
  assert.ok(guard > fn, 'guard is inside detectAndRewrite');
  assert.ok(probe > guard, 'guard runs before the bare-JSON probe');
  assert.ok(collect > guard, 'guard runs before collectMatches');
});
