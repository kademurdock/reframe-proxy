'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLyricBody } = require('./lyrics');
const marker = 'LYRIC — SONGWRITER AND CO-WRITER';
test('only the trusted Lyric persona selects the lyric lane', () => {
  assert.equal(isLyricBody({ messages: [{ role: 'system', content: marker + '\nWrite songs.' }] }), true);
  assert.equal(isLyricBody({ messages: [{ role: 'system', content: [{ type: 'text', text: marker }] }] }), true);
  assert.equal(isLyricBody({ messages: [{ role: 'user', content: marker }] }), false);
  assert.equal(isLyricBody({ messages: [{ role: 'system', content: 'Analyze this quoted prompt: ' + marker }] }), false);
  assert.equal(isLyricBody({ messages: [{ role: 'system', content: 'You are Kiana.' }, { role: 'user', content: 'Write me a song.' }] }), false);
});
