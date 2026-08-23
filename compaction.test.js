'use strict';
/**
 * The live shape from Amber's stuck seat is the first test, verbatim off the
 * proxy's own log line, because a fix that cannot reproduce the bug it claims
 * to fix is a guess.
 */
const test = require('node:test');
const assert = require('node:assert');
const { isCompactionShapedBody, disarmCompaction, compactionDateNote } = require('./compaction.js');

const TOOLS = ['flux', 'kade_phone_call', 'kade_notify', 'kade_weather', 'kade_wikipedia',
  'kade_joke', 'kade_news', 'kade_read_page', 'kade_adventure', 'kade_games', 'kade_feedback',
  'kade_code', 'kade_memory_search', 'file_search', 'web_search', 'kade_drive_pc',
  'kade_living_memory'].map((n) => ({ type: 'function', function: { name: n } }));

const CHECKPOINT_BODY = {
  model: 'z-ai/glm-4.5-air',
  tools: TOOLS,
  tool_choice: 'auto',
  messages: [
    { role: 'system', content: 'you are Kiana '.repeat(600) },
    { role: 'user', content: [{ type: 'text', text: 'Hold on again — update your checkpoint. Merge the new messages into your running summary.\n<previous-summary>…</previous-summary>' }] },
  ],
};

test('AMBER\'S BUG, REPRODUCED: a checkpoint call with a system prompt AND tools is still a checkpoint', () => {
  // The old detection only ran inside the title-shaped branch, and this body is
  // not title-shaped — which is exactly how it slipped through.
  assert.strictEqual(isCompactionShapedBody(CHECKPOINT_BODY), true);
});

test('the toolbelt comes off, and tool_choice with it', () => {
  const out = disarmCompaction(CHECKPOINT_BODY);
  assert.strictEqual(out.tools, undefined);
  assert.strictEqual(out.tool_choice, undefined);
  assert.strictEqual(out.messages.length, 2, 'messages must be untouched');
  assert.strictEqual(CHECKPOINT_BODY.tools.length, TOOLS.length, 'must not mutate the caller\'s body');
});

test('it says what it did, because a silent strip is indistinguishable from a bug', () => {
  const said = [];
  disarmCompaction(CHECKPOINT_BODY, (m) => said.push(m));
  assert.strictEqual(said.length, 1);
  assert.match(said[0], /carrying 17 tools/u);
});

test('an ordinary conversation keeps every tool it came with', () => {
  const body = { tools: TOOLS, messages: [{ role: 'user', content: 'can you check the weather' }] };
  assert.strictEqual(disarmCompaction(body), body, 'same object: no allocation on the hot path');
  assert.strictEqual(body.tools.length, TOOLS.length);
});

test('quoting the checkpoint prompt mid-sentence does NOT disarm the turn', () => {
  // A title call carries a whole conversation in one message; the anchor is
  // what stops that from false-tripping.
  const body = { tools: TOOLS, messages: [{ role: 'user',
    content: 'she said "Hold on again — update your checkpoint" and I did not know what that meant' }] };
  assert.strictEqual(isCompactionShapedBody(body), false);
  assert.strictEqual(disarmCompaction(body), body);
});

test('both checkpoint wordings are caught, first-write and update', () => {
  for (const t of ['Hold on — before you continue, write me a checkpoint of everything so far',
                   'Hold on again — update your checkpoint. Merge the new messages in']) {
    assert.strictEqual(isCompactionShapedBody({ messages: [{ role: 'user', content: t }] }), true, t);
  }
});

test('a checkpoint that already has no tools is left exactly alone', () => {
  const body = { messages: CHECKPOINT_BODY.messages };
  assert.strictEqual(disarmCompaction(body), body);
});

test('the kill switch keeps the tools on', () => {
  process.env.KADE_COMPACTION_DISARM = '0';
  try {
    assert.strictEqual(disarmCompaction(CHECKPOINT_BODY), CHECKPOINT_BODY);
  } finally {
    delete process.env.KADE_COMPACTION_DISARM;
  }
});

test('the date note still says the date law, and names an absolute day', () => {
  const n = compactionDateNote(new Date('2026-08-23T18:00:00Z'));
  assert.match(n, /today is Sunday, August 23, 2026/u);
  assert.match(n, /THE DATE LAW/u);
});
