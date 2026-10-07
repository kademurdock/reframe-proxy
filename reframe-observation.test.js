'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detect } = require('./reframe-filter');
const { conversationalRewriteMatches } = require('./conversation-style');
const { buildTargets } = require('./phrase-repair');

test('bare contraction contrasts have exact observations without authorizing a paid rewrite', () => {
  for (const text of [
    "This isn't control. It's care.",
    "That isn’t patience, that’s avoidance.",
    "These aren't choices; those are demands.",
    "That isn't fair—it's favoritism.",
  ]) {
    const result = detect(text);
    assert.ok(result.tripped, text);
    const match = result.matches.find(m => m.pattern === 'isnt_reframe');
    assert.ok(match, text);
    assert.equal(text.slice(...match.span), match.text);
    assert.ok(match.x && match.y);
    assert.deepEqual(conversationalRewriteMatches(result.matches), [], text);
  }
});

test('ordinary factual corrections remain observable speech, and quotation/code stays protected', () => {
  for (const text of ["This isn't Tuesday. It's Thursday.", "That isn't coffee. It's tea."]) {
    assert.ok(detect(text).tripped);
    assert.deepEqual(conversationalRewriteMatches(detect(text).matches), []);
  }
  for (const text of [
    '"This isn\'t control. It\'s care."',
    '“This isn’t control. It’s care.”',
    '```\nThis isn\'t control. It\'s care.\n```',
  ]) assert.deepEqual(buildTargets(text, detect(text).matches), []);
});

test('new contraction rule stays sentence-local and respects strict sensitivity', () => {
  for (const text of ["This isn't working.", "That isn't fair?", "This isn't control\n\nIt's care."]) {
    assert.deepEqual(detect(text).matches.filter(m => m.pattern === 'isnt_reframe'), [], text);
  }
  assert.equal(detect("This isn't control. It's care.", {level: 'strict'}).tripped, false);
});
