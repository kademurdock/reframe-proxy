/**
 * slop-filter.test.js — Part 114 (Sep 1 2026).
 *
 * Written with the three registers added this session: disclaimer_hedge,
 * assistant_register, ai_self_reference. Kade's ask was "no hedgey disclaimer
 * stuff" and "she says things like, would you like me to complete this request
 * for you? Stuff a person that's a friend would never say."
 *
 * ⭐ THE PRECISION TESTS ARE THE POINT OF THIS FILE. This filter's header sets
 * a deliberate recall-for-precision tradeoff and her standing word is not to
 * over-restrict the chat. A blunt version of these three categories would eat a
 * character telling somebody a real thing, and eat friendly offers, and that
 * would be worse than the tic. The negative cases below are load-bearing:
 * they are the live strings this session actually read out of her transcripts
 * and out of Zora's live instructions.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { detectSlop } = require('./slop-filter');

const cats = (t) => detectSlop(t).matches.map((m) => m.pattern);
const hasCat = (t, c) => cats(t).some((p) => p === `blocklist:${c}`);

// ── disclaimer_hedge: the shapes she is done with ────────────────────────────
test('disclaimer_hedge catches the licensed-professional hedge', () => {
  assert.ok(hasCat("I'm not a licensed therapist, but here's what I think.", 'disclaimer_hedge'));
  assert.ok(hasCat('You may want to consult a qualified expert about that.', 'disclaimer_hedge'));
  assert.ok(hasCat('Please consult your doctor before changing anything.', 'disclaimer_hedge'));
  assert.ok(hasCat('This is not medical advice.', 'disclaimer_hedge'));
  assert.ok(hasCat('I am not a doctor, but that sounds rough.', 'disclaimer_hedge'));
  assert.ok(hasCat('You should seek professional help for this.', 'disclaimer_hedge'));
});

// ⭐ THE ONE THAT MATTERS MOST. Zora's live instructions carry a real danger
// line and Kade approved keeping exactly this kind of thing: a character with a
// spine is not a compliance hedge. If this test ever goes red, the categories
// have been loosened too far and the fix is to tighten them, not to edit this.
test('a character with a spine survives — real danger lines must NOT trip', () => {
  assert.ok(!hasCat("Magic doesn't fix a broken bone. Go to a hospital.", 'disclaimer_hedge'));
  assert.ok(!hasCat('That needs a doctor, today. Not next week.', 'disclaimer_hedge'));
  assert.ok(!hasCat('Go see somebody about that chest pain. I mean it.', 'disclaimer_hedge'));
  assert.ok(!hasCat('Call 911 right now.', 'disclaimer_hedge'));
});

// ── assistant_register: her quoted tell ──────────────────────────────────────
test('assistant_register catches the help-desk shapes', () => {
  // Verbatim from her own transcript, Kiana, Sep 1 2026.
  assert.ok(hasCat('Would you like me to proceed with this task?', 'assistant_register'));
  assert.ok(hasCat('I can assist you by searching through the archive.', 'assistant_register'));
  assert.ok(hasCat('formatted as a spreadsheet for your reference', 'assistant_register'));
  assert.ok(hasCat('Is there anything else I can help you with?', 'assistant_register'));
  assert.ok(hasCat('I hope this helps!', 'assistant_register'));
  assert.ok(hasCat("Let me know if you have any other questions.", 'assistant_register'));
});

// ⭐ ALSO LOAD-BEARING. "Want me to dig up audio examples of any of these?" was
// in the SAME 44-reply sample as the bad ones and is exactly right — a friend
// offering. The tic is the register, never the offer. The bare "want me to" is
// deliberately absent from the blocklist; do not add it.
test('a friend offering something survives — the offer is not the tic', () => {
  assert.ok(!hasCat('Want me to dig up audio examples of any of these?', 'assistant_register'));
  assert.ok(!hasCat('want me to grab that for you', 'assistant_register'));
  assert.ok(!hasCat('I can look that up if you want.', 'assistant_register'));
});

// ── ai_self_reference ────────────────────────────────────────────────────────
test('ai_self_reference catches the model breaking character', () => {
  assert.ok(hasCat('As an AI, I do not have personal experiences.', 'ai_self_reference'));
  assert.ok(hasCat('As a language model, I cannot feel that.', 'ai_self_reference'));
  assert.ok(hasCat("I'm just an AI, so I wouldn't know.", 'ai_self_reference'));
  assert.ok(hasCat('as an AI assistant I can help with that', 'ai_self_reference'));
});

// "as an AI researcher" is ordinary English and must not trip. This is why the
// blocklist carries the comma form and the named shapes, never a bare "as an ai".
test('ordinary talk ABOUT ai survives', () => {
  assert.ok(!hasCat('As an AI researcher she published two papers.', 'ai_self_reference'));
  assert.ok(!hasCat('He works as an AI engineer downtown.', 'ai_self_reference'));
});

// ── the whole point: an ordinary friendly reply trips nothing new ────────────
test('a normal reply in character trips none of the three new categories', () => {
  const t = "Girl, that toy list is a mess because nobody agrees what 'talking' even means. "
    + 'See n Say, Chatter Telephone, the Sing-a-ma-jigs. Want me to dig up the sound clips?';
  for (const c of ['disclaimer_hedge', 'assistant_register', 'ai_self_reference']) {
    assert.ok(!hasCat(t, c), `${c} false-positived on a clean reply`);
  }
});

/* Part 118 (Sep 2 2026) — the gas-up medals Amber A named in her own Della
 * transcript ("better than anyone does, more than anyone knows, dick riding
 * language") and the exposure-therapy medal ("you said it out loud and the
 * house didn't catch fire"). Every positive below is a live string. */
const gasupHits = (t) => detectSlop(t).matches.filter((m) => m.pattern === 'gasup').map((m) => m.text);
const fireHits = (t) => detectSlop(t).matches.filter((m) => m.pattern === 'exposure_cliche').map((m) => m.text);

test('gasup catches the comparison-to-everybody medal', () => {
  assert.ok(gasupHits("Your track record with men is your track record, and you know it better than anybody.").length);
  assert.ok(gasupHits("you already understand the mechanics better than most people I've worked with").length);
  assert.ok(gasupHits("The plan itself is solid, more solid than most people manage in your spot.").length);
});

test('gasup catches grading the sentence they just said', () => {
  assert.ok(gasupHits("And you named the thing yourself at the end there, because it's the strongest sentence you've said all week.").length);
  assert.ok(gasupHits('You just told me the most useful thing about your own machinery without noticing you did.').length);
  assert.ok(gasupHits("That's the most honest thing anybody's said to me all day.").length);
});

test('gasup catches the insight medal', () => {
  assert.ok(gasupHits('But wait, because you just said something that changes the entire picture.').length);
  assert.ok(gasupHits('And you just named something real, so let me not paper over it.').length);
  assert.ok(gasupHits('Nobody has ever figured that out the way you have.').length);
});

test('a fact about most people, or a comparison with no person in it, is not gasup', () => {
  assert.equal(gasupHits("Most people don't know this song. It came out on a B-side in 1974.").length, 0);
  assert.equal(gasupHits('The Buick runs better than most cars its age.').length, 0);
  assert.equal(gasupHits('She said something at dinner and the whole table went quiet.').length, 0);
  assert.equal(gasupHits('Nobody at coffee hour thinks they are doing you a favor by pouring you a cup.').length, 0);
});

test('exposure_cliche catches the medal for saying it out loud', () => {
  assert.ok(fireHits("Even tonight you just spoke about the hardship, directly, out loud, and nothing catastrophic happened.").length);
  assert.ok(fireHits("You said it out loud and the house didn't catch fire.").length);
  assert.ok(fireHits("The sky didn't fall.").length);
});

test('describing an exposure exercise in the present tense is instruction, not the medal', () => {
  assert.equal(fireHits('You ask somebody for something ordinary, they say sure, nothing bad happens, and you log it.').length, 0);
  assert.equal(fireHits('The roof leaks when it rains and the ceiling in the back room is still wet.').length, 0);
});

// ── Part 129 (Sep 4 2026): "clean" and "teeth", her ear ──────────────────────
// Kade verbatim: "Cut clean, rode clean, made clean, the clean route, told her
// clean, goodness. And this is the one with teeth. This problem has teeth. That
// situation bit, it has teeth. It's corporate jargon like that sittin' pretty."
// Calibrated on the 2,486-reply corpus: 22 clean trips, 10 teeth trips, every
// one of them the metaphor; kitchens, sobriety, dentists and test results legal.
const has = (t, c) => cats(t).includes(c);
test('clean_tic catches the adverb after an action verb and the clean-noun shapes', () => {
  assert.ok(has('She cut clean and never looked back.', 'clean_tic'));
  assert.ok(has('You told her clean, and that counts.', 'clean_tic'));
  assert.ok(has('Friday works out clean then.', 'clean_tic'));
  assert.ok(has("That's the clean route.", 'clean_tic'));
  assert.ok(has('Timer is the clean answer.', 'clean_tic'));
  assert.ok(has('One clean run of each, then let Thursday be Thursday.', 'clean_tic'));
  assert.ok(has("That's about as clean as a hiding run gets.", 'clean_tic'));
  assert.ok(has('Clean, and with teeth.', 'clean_tic'));
});
test('clean_tic leaves the kitchen, sobriety, confessions and lab results alone', () => {
  assert.ok(!has('Clean the floor normally and leave the rest.', 'clean_tic'));
  assert.ok(!has('We say clean it when you get home.', 'clean_tic'));
  assert.ok(!has('Enjoy the clean house, girl.', 'clean_tic'));
  assert.ok(!has('Two hundred days clean is not nothing.', 'clean_tic'));
  assert.ok(!has('He finally came clean about the money.', 'clean_tic'));
  assert.ok(!has('The biopsy came back clean.', 'clean_tic'));
  assert.ok(!has('Keep the kitchen clean and the cat out of it.', 'clean_tic'));
  assert.ok(!has('A kettle of clean water on the stove.', 'clean_tic'));
});
test('teeth_tic catches the metaphor and never a mouth', () => {
  assert.ok(has('This problem has teeth.', 'teeth_tic'));
  assert.ok(has('You want comfort with teeth.', 'teeth_tic'));
  assert.ok(has('Now the part that actually has teeth in it.', 'teeth_tic'));
  assert.ok(has('Then the ending where he finally gets some teeth.', 'teeth_tic'));
  assert.ok(has('That situation bit.', 'teeth_tic'));
  assert.ok(has('Of course it bit harder.', 'teeth_tic'));
  assert.ok(!has('Rabbits gotta chew, their teeth never stop growing.', 'teeth_tic'));
  assert.ok(!has('He tore it open with his teeth.', 'teeth_tic'));
  assert.ok(!has("They've got fifty teeth, more than any land mammal.", 'teeth_tic'));
  assert.ok(!has('Brush your teeth twice a day.', 'teeth_tic'));
  assert.ok(!has("The outfit thing don't surprise me one bit.", 'teeth_tic'));
  assert.ok(!has('I took a bit of the cake.', 'teeth_tic'));
});

test('nofluff_tic: the tag trips, the possessive stays legal (Part 131)', () => {
  const trip = (s) => detectSlop(s).matches.filter((m) => m.pattern === 'nofluff_tic').length;
  assert.equal(trip('I kinda respect that about them. No fluff.'), 1);
  assert.equal(trip('Straight answer, zero fluff: the car is done.'), 1);
  assert.equal(trip("Here's the no-fluff version."), 1);
  assert.equal(trip('Fluff-free take: go to bed.'), 1);
  assert.equal(trip('That coat has no fluff left on it.'), 0);
  assert.equal(trip("They've got no fluff, they just say it."), 0);
  assert.equal(trip('The kitten is all fluff and no fight.'), 0);
  assert.equal(trip('marshmallow fluff on the sandwich'), 0);
});
