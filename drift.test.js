const test = require('node:test');
const assert = require('node:assert');
const { findDrift, applyDrift, userAskedForDraft } = require('./drift');

/* The real thing, trimmed but structurally faithful: a good answer, a clean
 * natural ending, then the seam. Verbatim fragments from the Aug 25 reply so
 * this test fails if the marker set ever stops matching what actually shipped. */
const CASIO = `%%%leaning in like I've got receipts on this one%%%

I don't think it's either of those. Waste and obesity are both real pressures on food marketing, but the mail-in promo died of something way more boring: the barcode.

Then the internet ate the rest of it. Somewhere in the 2000s the promo became a code printed inside the box that you typed into a website. Cheaper for the company, instant for the kid, no fulfillment warehouse full of plastic cameras in Ohio.

The main reason is that the prize got worse. Now a kid has a phone in their pocket that shoots video, and the toy in the cereal box is a QR code to a website that asks for your email. Hard to beg your mom for that.

I think this is my second post here, and I remember this community being pretty great, and I hope it still is.

I have been in an absolute tailspin with my Casio PX-S1100 and would deeply appreciate some guidance from you fine folks.

Any help, anecdotes, or commiseration is appreciated. Thanks in advance!

(BTW, if this post belongs somewhere else, let me know.)`;

test('the Casio reply is caught, and the good answer survives', () => {
  const hit = findDrift(CASIO);
  assert.ok(hit, 'should have found the seam');
  const kept = CASIO.slice(0, hit.cut);
  assert.ok(kept.includes('Hard to beg your mom for that.'),
    'the real answer must survive whole');
  assert.ok(!kept.includes('second post here'), 'the forum post must not survive');
  assert.ok(!kept.includes('Casio'), 'nothing of the regurgitation may remain');
  assert.ok(hit.dropped > 300, `should have dropped the whole post, dropped ${hit.dropped}`);
});

test('the cut lands on a paragraph boundary, not mid-sentence', () => {
  const out = applyDrift(CASIO).text;
  assert.ok(/[.!?]$/.test(out.trim()),
    `a cut reply must end on a finished sentence, got: ${JSON.stringify(out.slice(-60))}`);
});

test('a normal reply is untouched — this is the case that matters most', () => {
  const ordinary = `%%%warming up%%%

Man, you just cracked open a whole freezer section of memory. Okay.

Kid Cuisine is a real microwave dinner with a tray, film you peel back, and actual cooking involved. It's Conagra, been around since the eighties, and the whole concept was "TV dinner, but a kid picks it."

Lunchables is a different animal entirely. Oscar Mayer, 1988, and the entire point is that nothing is hot. It's an assembly kit, and you build it yourself.`;
  assert.strictEqual(findDrift(ordinary), null);
  assert.strictEqual(applyDrift(ordinary).cut, false);
});

/* THE FALSE POSITIVE THAT WOULD ACTUALLY HAPPEN. Somebody asks her to draft a
 * post; every marker fires on a reply that is exactly right. */
test('a requested draft is left alone', () => {
  const draft = `Here's one you could post:

I think this is my first post here, so apologies if this is the wrong sub. I have been having trouble getting my hearing aids to pair over Bluetooth, and I would appreciate any help.

Thanks in advance!

Want me to make it shorter?`;
  assert.strictEqual(
    findDrift(draft, { userText: 'can you write me a reddit post asking about my hearing aids' }),
    null,
    'a reply she asked for must never be cut',
  );
});

test('the draft escape hatch is broad on purpose', () => {
  assert.ok(userAskedForDraft('write me a forum post about this'));
  assert.ok(userAskedForDraft('how should I word this question for reddit'));
  assert.ok(userAskedForDraft('draft a message to the group'));
  assert.ok(userAskedForDraft('help me with a listing for marketplace'));
  assert.ok(!userAskedForDraft('why did cereal boxes stop doing mail-in prizes?'));
  assert.ok(!userAskedForDraft('what is the difference between kid cuisine and lunchables'));
});

test('a reply that was post-shaped from its first word is left for a human', () => {
  const allPost = `Has anyone here dealt with a Casio that will not pair? Any help appreciated. Thanks in advance! I have tried everything I can think of and I am running out of ideas, so I would be grateful for anything at all that anyone can suggest here.`;
  assert.strictEqual(findDrift(allPost), null,
    'no good answer in front of the marker means this is not the Casio shape');
});

test('short replies are never cut', () => {
  assert.strictEqual(findDrift('Thanks in advance!'), null);
});

test('findDrift is safe on partial and empty input', () => {
  assert.strictEqual(findDrift(''), null);
  assert.strictEqual(findDrift(null), null);
  assert.strictEqual(findDrift(undefined), null);
  const partial = CASIO.slice(0, 400);
  assert.doesNotThrow(() => findDrift(partial));
});

test('it fires as soon as the seam streams in, not only at the end', () => {
  // Everything up to and including the first marker sentence.
  const upToMarker = CASIO.slice(0, CASIO.indexOf('second post here') + 20);
  const hit = findDrift(upToMarker);
  assert.ok(hit, 'a mid-stream cut is the only cut that stops it being spoken');
  assert.ok(CASIO.slice(0, hit.cut).includes('Hard to beg your mom for that.'));
});

test('the earliest marker wins when several are present', () => {
  const hit = findDrift(CASIO);
  const firstMarkerAt = CASIO.indexOf('second post here');
  assert.ok(hit.cut < firstMarkerAt, 'cut must precede the earliest marker');
});
