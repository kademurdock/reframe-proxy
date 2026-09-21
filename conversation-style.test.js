'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { conversationalRewriteMatches } = require('./conversation-style');

test('plain contrast flags alone are observations, and mixed substantive flags still reach repair', () => {
  const observations = [{pattern:'reframe_bare'}, {pattern:'isnt_reframe'}];
  assert.deepEqual(conversationalRewriteMatches(observations), []);
  const echo = {pattern:'user_echo'}, label = {pattern:'blocklist:personal_label'};
  assert.deepEqual(conversationalRewriteMatches([...observations, echo, label]), [echo,label]);
  assert.equal(observations.length, 2);
});

test('rollback restores original matches without rewriting their evidence', () => {
  const matches = [{pattern:'reframe_bare', text:'That is not a hat. That is a satellite dish.'}];
  process.env.KADE_CONVERSATION_STYLE_OBSERVE='0';
  try { assert.equal(conversationalRewriteMatches(matches), matches); }
  finally { delete process.env.KADE_CONVERSATION_STYLE_OBSERVE; }
});
