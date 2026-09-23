'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { detectStockPhrasing, buildTargets, applyEdits, repairPhrases } = require('./phrase-repair');
const draft = "%%%amused%%% Damn, I like it. That matters because you can restore yesterday's copy.\n\nI'd still keep the blue one.";
const targets = buildTargets(draft, detectStockPhrasing(draft));
const edit = { id: 0, before: 'That matters because you', after: 'You' };

test('edits a clause and preserves every unrelated byte and performance tag', () => {
  const r = applyEdits(draft, targets, JSON.stringify({ edits: [edit] }));
  assert.equal(r.status, 'edited');
  assert.equal(r.text, draft.replace(edit.before, edit.after));
});
test('empty edit decision preserves an ordinary use', () => {
  const text = 'I love the part where the dog steals his sandwich.';
  assert.equal(applyEdits(text, buildTargets(text, detectStockPhrasing(text)), '{"edits":[]}').text, text);
});
test('code, quoted phrases, blockquotes and URLs do not become new targets', () => {
  for (const text of ['"That matters because I care."', '“The part that hurts.”', "'The part that hurts.'", '`That matters because`', '```js\nThat matters because\n```', '```\nThe part that hurts', '> The part that hurts.', '[the part that hurts](https://example.com)', '    That matters because it works.']) {
    assert.deepEqual(detectStockPhrasing(text), [], text);
  }
});
test('legacy flags inside protected text cannot authorize an edit', () => {
  const text = 'She said "that is main character energy" and laughed.';
  const at = text.indexOf('main');
  assert.deepEqual(buildTargets(text, [{ pattern: 'internet_label', span: [at, at + 10] }]), []);
});
test('all suspect families carry exact source positions', () => {
  const text = "That matters, because I care. The part that's annoying is the delay. So the straight version: I liked it.";
  const m = detectStockPhrasing(text);
  assert.equal(m.length, 3);
  for (const x of m) assert.equal(text.slice(...x.span), x.text);
});
test('local targets are bounded even for many flags or enormous sentences', () => {
  const text = Array.from({ length: 20 }, (_, i) => `That matters because item ${i} is here.`).join('\n');
  assert.equal(buildTargets(text, detectStockPhrasing(text)).length, 8);
  const huge = 'That matters because ' + 'word '.repeat(250);
  assert.equal(buildTargets(huge, detectStockPhrasing(huge)).length, 0);
});
test('echo and cadence detectors with no offsets resolve a bounded sentence', () => {
  const text = "%%%warm%%% I like your idea. You didn't ask for another plan.";
  for (const needle of ["You didn't ask for another", 'you didn t ask for another']) {
    const t = buildTargets(text, [{ pattern: 'user_echo', span: [0, 0], detail: needle }]);
    assert.equal(t.length, 1); assert.equal(t[0].text, "You didn't ask for another plan.");
  }
  assert.deepEqual(buildTargets(text, [{ pattern: 'user_echo', span: [0, 0], text: 'not in the draft' }]), []);
});
test('malformed, invented, overlapping and out-of-target edits fail open atomically', () => {
  for (const payload of [
    'not json', '{}', JSON.stringify({ edits: [{ ...edit, id: 99 }] }),
    JSON.stringify({ edits: [{ ...edit, before: 'not present' }] }),
    JSON.stringify({ edits: [edit, { ...edit, before: 'That matters because', after: '' }] }),
    JSON.stringify({ edits: [edit, { ...edit, before: "I'd still keep the blue one.", after: 'Bye.' }] }),
    JSON.stringify({ edits: [{ ...edit, after: '%%%shout%%% You' }] }),
    JSON.stringify({ edits: [{ ...edit, after: 'You\nHello' }] }),
  ]) assert.equal(applyEdits(draft, targets, payload).text, draft, payload);
});
test('new numbers and changes to existing numeric claims are rejected', () => {
  assert.equal(applyEdits(draft, targets, JSON.stringify({ edits: [{ ...edit, after: 'You have 3 copies and you' }] })).status, 'protected_edit');
  const text = 'That matters because it costs $12.50, not $20.';
  const t = buildTargets(text, detectStockPhrasing(text));
  assert.equal(applyEdits(text, t, JSON.stringify({ edits: [{ id: 0, before: text, after: 'It costs $20.' }] })).text, text);
});
test('an edit cannot remove quoted speech or voice tags within a target', () => {
  for (const text of ['%%%warm%%% That matters because I care.', 'The part that hurts is "I forgot you."']) {
    const t = buildTargets(text, detectStockPhrasing(text));
    assert.equal(applyEdits(text, t, JSON.stringify({ edits: [{ id: 0, before: text, after: 'I care.' }] })).text, text);
  }
});
test('ambiguous repeated substring and deletion of most of the answer are rejected', () => {
  const text = 'That matters because you know you care.';
  const t = buildTargets(text, detectStockPhrasing(text));
  assert.equal(applyEdits(text, t, JSON.stringify({ edits: [{ id: 0, before: 'you', after: 'I' }] })).status, 'invalid_span');
  assert.equal(applyEdits(text, t, JSON.stringify({ edits: [{ id: 0, before: text, after: '' }] })).status, 'excessive_edit');
});
test('multiple distant edits are applied at original offsets', () => {
  const text = 'That matters because I care. Good coffee. The part that worries me is the backup.';
  const t = buildTargets(text, detectStockPhrasing(text));
  const r = applyEdits(text, t, JSON.stringify({ edits: [
    { id: 0, before: 'That matters because I', after: 'I' },
    { id: 1, before: 'The part that worries me is', after: "I'm worried about" },
  ] }));
  assert.equal(r.text, "I care. Good coffee. I'm worried about the backup.");
});
test('one bounded utility call with original usage separate; timeout never triggers a whole rewrite', async () => {
  let calls = 0;
  const complete = async (body, timeout) => {
    calls++; assert.equal(timeout, 12000); assert.equal(body.max_tokens, 1600);
    assert.equal(JSON.parse(body.messages[1].content).user, 'Can I recover my file?');
    return { choices: [{ message: { content: JSON.stringify({ edits: [edit] }) }, finish_reason: 'stop' }], usage: { prompt_tokens: 55 } };
  };
  const r = await repairPhrases(draft, detectStockPhrasing(draft), { complete, model: 'test', userText: 'Can I recover my file?' });
  assert.equal(calls, 1); assert.equal(r.status, 'edited'); assert.equal(r.usage.prompt_tokens, 55);
  const failed = await repairPhrases(draft, detectStockPhrasing(draft), { complete: async () => { throw Error('timeout'); } });
  assert.equal(failed.status, 'failed'); assert.equal(failed.text, draft);
});
test('truncated JSON is rejected even if parseable; protected-only hits spend nothing', async () => {
  const r = await repairPhrases(draft, detectStockPhrasing(draft), { complete: async () => ({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ edits: [edit] }) } }] }) });
  assert.equal(r.status, 'truncated'); assert.equal(r.text, draft);
  const no = await repairPhrases('"That matters because"', [{ span: [1, 10] }], { complete: () => assert.fail('no call') });
  assert.equal(no.status, 'no_targets');
});
