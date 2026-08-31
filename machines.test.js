'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { isMemorySummaryShapedBody, isDiaryRepairShapedBody, isSweptMachineBody } = require('./machines.js');

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
