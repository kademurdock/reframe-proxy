/* sensitive.test.js — Aug 28 2026.
 *
 * A provider content-filter verdict must never be served as silence. Her
 * second-ever photo turn: upstream 200, finishReason=sensitive, zero content
 * -- the app turned it into an error tone and she reported the platform
 * broken. The notice is the cure; these pin its fence posts.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const M = require('./modelbudget');

const IMG_BODY = { messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }] };
const TEXT_BODY = { messages: [{ role: 'user', content: 'hey' }] };

test('HER TURN: sensitive + zero content is caught', () => {
  assert.ok(M.isSensitiveBlockedTurn({ finishReason: 'sensitive', contentLength: 0 }));
});

test("OpenRouter's spelling of the same verdict is caught too", () => {
  assert.ok(M.isSensitiveBlockedTurn({ finishReason: 'content_filter', contentLength: 0 }));
});

test('a filtered turn that still SAID something is left alone', () => {
  // If the provider filtered mid-stream after real words, the words stand;
  // stomping them with a canned notice would be the worse bug.
  assert.ok(!M.isSensitiveBlockedTurn({ finishReason: 'sensitive', contentLength: 412 }));
});

test('ordinary finishes never trip it', () => {
  for (const fr of ['stop', 'length', 'error', 'tool_calls', undefined, null]) {
    assert.ok(!M.isSensitiveBlockedTurn({ finishReason: fr, contentLength: 0 }), String(fr));
  }
});

test('the notice knows whether a picture was involved', () => {
  const img = M.sensitiveBlockedNotice(IMG_BODY);
  const txt = M.sensitiveBlockedNotice(TEXT_BODY);
  assert.match(img.text, /picture/i);
  assert.match(img.text, /Describe/i, 'the image notice must point at the road that works');
  assert.ok(!/picture/i.test(txt.text), 'a text-only block must not claim there was a picture');
  assert.strictEqual(img.finishReason, 'stop');
});

test('the notice never pretends to have seen anything', () => {
  const t = M.sensitiveBlockedNotice(IMG_BODY).text.toLowerCase();
  for (const claim of ['i can see', 'i see a', 'looks like', 'in the image i']) {
    assert.ok(!t.includes(claim), `notice implies sight: ${claim}`);
  }
});

/* All three lanes are wired, asserted against comment-stripped source so a
 * lane can never quietly lose its notice (the disarmed-guard shape, twice
 * now on this proxy). */
test('all three lanes call the notice', () => {
  const src = fs.readFileSync(require.resolve('./server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const hits = (src.match(/isSensitiveBlockedTurn\(\{/g) || []).length;
  assert.strictEqual(hits, 3, `expected the detector at 3 lane sites, found ${hits}`);
  const notices = (src.match(/sensitiveBlockedNotice\(upstreamBody\)/g) || []).length;
  assert.strictEqual(notices, 3, `expected the notice at 3 lane sites, found ${notices}`);
});

/* ── THE POISONED THREAD (Aug 28 2026, evening) ─────────────────────────────
 * Her selfie was innocent; the already-refused lighter photo replaying in
 * the history killed the turn anyway. stripPriorImages removes EARLIER
 * images, keeps the newest message's images, and drops nothing else. */
const { stripPriorImages } = require('./modelbudget');

const lighter = { type: 'image_url', image_url: { url: 'data:image/png;base64,LIGHTER' } };
const selfie = { type: 'image_url', image_url: { url: 'data:image/png;base64,SELFIE' } };

test('HER THREAD: the old lighter is stripped, the new selfie survives', () => {
  const { messages, stripped } = stripPriorImages([
    { role: 'system', content: 'persona' },
    { role: 'user', content: [{ type: 'text', text: '' }, lighter] },
    { role: 'assistant', content: 'that got filtered' },
    { role: 'user', content: [{ type: 'text', text: 'what about this one?' }, selfie] },
  ]);
  assert.strictEqual(stripped, 1);
  const old = messages[1].content;
  assert.ok(old.every((p) => p.type === 'text'), 'the lighter must be gone');
  assert.match(old.map((p) => p.text).join(' '), /removed/, 'a placeholder marks where it was');
  assert.ok(messages[3].content.some((p) => p.type === 'image_url'), 'the selfie must survive untouched');
});

test('a single-image turn strips nothing — there is no earlier poison to remove', () => {
  const { stripped } = stripPriorImages([
    { role: 'user', content: [{ type: 'text', text: 'look' }, lighter] },
  ]);
  assert.strictEqual(stripped, 0);
});

test('no images anywhere: untouched by reference', () => {
  const msgs = [{ role: 'user', content: 'plain words' }];
  const out = stripPriorImages(msgs);
  assert.strictEqual(out.messages, msgs);
  assert.strictEqual(out.stripped, 0);
});

test('three photo turns: the two older strip, the newest stays', () => {
  const { messages, stripped } = stripPriorImages([
    { role: 'user', content: [lighter] },
    { role: 'user', content: [lighter] },
    { role: 'user', content: [{ type: 'text', text: 'and this' }, selfie] },
  ]);
  assert.strictEqual(stripped, 2);
  assert.ok(messages[2].content.some((p) => p.type === 'image_url'));
});

test('the retry is wired ahead of the notice on both image-bearing lanes', () => {
  const src = fs.readFileSync(require.resolve('./server.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const wired = (src.match(/stripPriorImages\(upstreamBody\.messages\)/g) || []).length;
  assert.strictEqual(wired, 2, `expected the strip-retry on 2 lanes (buffered, shim-live), found ${wired}`);
  assert.ok(src.indexOf('stripPriorImages(upstreamBody.messages)') < src.indexOf('sensitiveBlockedNotice(upstreamBody)'),
    'the retry must be attempted before the notice is served');
});
