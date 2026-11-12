'use strict';
/* Nov 12 2026 — tests for the voice guard (voice-lexicon.js in register-edit.js and
 * phrase-repair.js), the editor prompt that no longer teaches "honestly", the "ain't" twin and the
 * per-character allow list (conversation-style.js), and the whole-word filter fixes
 * (slop-filter.js). Run: node --test voice-guard.test.js   (no network, no model) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceLoss, clauseCut, ticAdded, voiceTokens, licensedWords } = require('./voice-lexicon');
const { checkEdit, SYSTEM, SYSTEM_BEFORE_NOV12, systemFor, registerEdit } = require('./register-edit');
const phrase = require('./phrase-repair');
const { conversationalRewriteMatches, DEFAULT_VOICE_ALLOW } = require('./conversation-style');
const { detectSlop, BLOCKLIST } = require('./slop-filter');

const withEnv = (vars, fn) => {
  const old = {};
  for (const k of Object.keys(vars)) { old[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; } }
};

test('a cut is allowed: the negated half of a contrast can go, with its ain\'t', () => {
  assert.equal(voiceLoss("That dog ain't deaf, hon, he's negotiatin'.", "He's negotiatin', hon."), '');
  assert.equal(checkEdit("That dog ain't deaf, hon, he's negotiatin'.", "He's negotiatin', hon.", 'contrast'), '');
  assert.equal(voiceLoss("That ain't no damn firing, that's a promotion.", "That's a promotion."), '');
});

test('a translation is refused: dialect, swears and spoken lead-ins survive an edit that keeps the sentence', () => {
  const rest = 'Other words.';
  assert.equal(checkEdit('She finna be unbearable at the gas station now, watch.', "She's going to be unbearable at the gas station now, watch.", 'padding', rest), 'voice dropped');
  assert.equal(checkEdit('He was a damn fool and a hell of a liar.', 'He was a fool and a liar.', 'padding', rest), 'voice dropped');
  assert.equal(checkEdit('Lord, that boy can eat.', 'That boy can eat.', 'setup', rest), 'voice dropped');
  assert.equal(checkEdit("He is a fucking liar and that's the whole trick.", 'He is a liar.', 'maxim', rest), 'voice dropped');
  assert.equal(checkEdit('They was designed by an architect who hates holding things.', 'They were designed by an architect who hates holding things.', 'padding', rest), 'voice dropped');
  assert.equal(checkEdit("I ain't gonna say nothing.", 'I am not going to say anything.', 'padding', rest), 'voice dropped');
  assert.equal(checkEdit("Somebody talkin' crazy in that lot.", 'Somebody is talking crazy in that lot.', 'padding', rest), 'voice dropped');
  // grammar a word list cannot see
  assert.equal(checkEdit('Oh, he know exactly what he doing out there.', 'Oh, he knows exactly what he is doing out there.', 'padding', rest), 'voice dropped');
  assert.equal(voiceLoss('I might could fix that fence tomorrow.', 'I could fix that fence tomorrow.'), 'double-modal');
  // curly apostrophes, as the model writes them
  assert.equal(voiceLoss('I ain’t gonna say nothing.', 'I am not going to say anything.'), "ain't");
});

test('maxims are still deleted by default; the opt-in switch keeps a saying in the character\'s own words', () => {
  assert.equal(checkEdit("That dog ain't gonna hunt.", '', 'maxim'), '', 'maxims are her named peeve: deleting one stays allowed');
  assert.equal(checkEdit('So that is the easy half.', '', 'maxim'), '');
  withEnv({ KADE_VOICE_GUARD_MAXIM: '1' }, () => {
    assert.equal(checkEdit("That dog ain't gonna hunt.", '', 'maxim'), 'voice dropped');
    assert.equal(checkEdit('So that is the easy half.', '', 'maxim'), '');
  });
});

test('the editor cannot add a house tic the reply did not have, and may keep one it had', () => {
  assert.equal(checkEdit("Your dog's not ignoring you, he's retired.", "He's just retired, honestly.", 'contrast'), 'tic added');
  assert.equal(ticAdded('Honestly? No.', 'Honestly, no.'), '');
  assert.equal(checkEdit("Your dog's not ignoring you, he's retired.", "He's retired.", 'contrast'), '');
});

test('the editor prompt no longer teaches "honestly"; the switch sends the old prompt byte for byte', async () => {
  assert.doesNotMatch(SYSTEM, /honestly/i);
  assert.ok(SYSTEM.includes('"Your dog\'s not ignoring you, he\'s retired." -> "He\'s retired."'));
  assert.ok(SYSTEM.includes('("Well,", "Okay so", "I\'ll tell you where I land") are fine.'));
  assert.ok(SYSTEM_BEFORE_NOV12.includes('-> "He\'s just retired, honestly."'));
  assert.ok(SYSTEM_BEFORE_NOV12.includes('("Well,", "Okay so", "Honestly?", "I\'ll tell you where I land") are fine.'));
  assert.equal(SYSTEM_BEFORE_NOV12.length - SYSTEM.length, ' just'.length + ', honestly'.length + ' "Honestly?",'.length);
  assert.equal(systemFor({}), SYSTEM);
  assert.equal(systemFor({ KADE_VOICE_GUARD: '0' }), SYSTEM_BEFORE_NOV12);
  // what the editor model is actually sent
  const reply = 'Okay so, the classic grocery-store meltdown. There are real reasons it happens, and none of them are about you. '.repeat(3);
  const body = { messages: [{ role: 'system', content: "You're Kiana." }, { role: 'user', content: 'why does she melt down at the store' }] };
  const sent = [];
  const complete = async (req) => { sent.push(req.messages[0].content); return { choices: [{ message: { content: '{"edits":[]}' } }] }; };
  await registerEdit(reply, body, { complete, hosts: [], env: {} });
  await registerEdit(reply, body, { complete, hosts: [], env: { KADE_VOICE_GUARD: '0' } });
  assert.deepEqual(sent, [SYSTEM, SYSTEM_BEFORE_NOV12]);
});

test('"honestly" now counts as a new word, so it cannot ride in free beside two others', () => {
  const before = 'That is the part of the trip nobody warns you about.';
  const after = 'Honestly the airport security line took forever.';
  assert.equal(checkEdit(before, after, 'setup'), 'new words');
  withEnv({ KADE_VOICE_GUARD: '0' }, () => {
    // old behaviour: "honestly" was free, so only "airport" and "security" counted... and passed
    assert.equal(checkEdit(before, 'Honestly the airport security part.', 'setup'), '');
  });
  assert.equal(checkEdit(before, 'Honestly the airport security part.', 'setup'), 'new words');
});

test('KADE_VOICE_GUARD=0 restores the old register edit', () => {
  withEnv({ KADE_VOICE_GUARD: '0' }, () => {
    assert.equal(checkEdit('Lord, that boy can eat.', 'That boy can eat.', 'setup'), '');
    assert.equal(checkEdit("Your dog's not ignoring you, he's retired.", "He's just retired, honestly.", 'contrast'), '');
  });
});

test('voice tags, a standard sentence and an in-voice rewrite pass untouched by the guard', () => {
  assert.equal(checkEdit('%%%dry%%% Here is the part nobody tells you: the battery is the problem.', "%%%dry%%% The battery's the problem.", 'setup'), '');
  assert.equal(checkEdit("That is not laziness, that is his joints.", "Nah, it's his joints.", 'contrast'), '');
});

test('phrase repair skips a standardising edit and still applies the others', () => {
  const text = "The part that worries me is the missing backup. She finna lose the whole drive.";
  const targets = [
    { id: 0, start: 0, end: 47, text: text.slice(0, 47), flags: ['x'] },
    { id: 1, start: 48, end: text.length, text: text.slice(48), flags: ['x'] },
  ];
  const raw = JSON.stringify({ edits: [
    { id: 0, before: 'The part that worries me is the missing backup.', after: "I'm worried about the missing backup." },
    { id: 1, before: 'She finna lose the whole drive.', after: 'She is going to lose the whole drive.' },
  ] });
  const out = phrase.applyEdits(text, targets, raw);
  assert.equal(out.status, 'edited');
  assert.equal(out.voiceKept, 1);
  assert.match(out.text, /I'm worried about the missing backup\. She finna lose the whole drive\./);
  withEnv({ KADE_VOICE_GUARD: '0' }, () => {
    const old = phrase.applyEdits(text, targets, raw);
    assert.equal(old.voiceKept, 0);
    assert.match(old.text, /She is going to lose the whole drive\./);
  });
});

test('the dialect contrast is observed like its standard twin; the switch puts it back', () => {
  const m = [{ pattern: 'reframe_bare_aint', text: "That ain't love, that's control." }, { pattern: 'user_echo', text: 'x y z' }];
  assert.deepEqual(conversationalRewriteMatches(m).map((x) => x.pattern), ['user_echo']);
  withEnv({ KADE_AINT_TWIN: '0' }, () => assert.equal(conversationalRewriteMatches(m).length, 2));
});

const BODY = (persona) => ({ model: 'xiaomi/mimo-v2.6-pro', messages: [
  { role: 'system', content: 'House notes.\n\n' + persona + '\n\n## Voice performance v2\nDirections go in percent signs.' },
  { role: 'user', content: 'so what happened' },
] });
const KIANA = BODY("You're Kiana, the flagship.\n\n## 3. How you talk\nLoose and direct.");
const HARLEY = BODY('You are Harley Dalton, Harley to everybody, one of the companions of Kade-AI.\n\n## How you talk\nPlain.');
const EARL = BODY('You are Earl, 72, a retired long-haul trucker.\n\n## How you talk\nSlow.');
const FLAGS = [
  { pattern: 'throat_clearing_opener', text: 'Real talk,' },
  { pattern: 'that_part_meme', text: 'That part.' },
  { pattern: 'meme_combat', text: 'throw hands' },
  { pattern: 'throat_clearing_opener', text: 'Look,' },
  { pattern: 'blocklist:filler_transition', text: 'at the end of the day' },
  { pattern: 'reframe_second_person', text: "He don't love you, he loves the attention." },
  { pattern: 'blocklist:everything_gush', text: 'tell me everything' },
];
const kept = (body, env) => conversationalRewriteMatches(FLAGS, body, env).map((x) => x.text);

test('the allow list: the approved wording is each character\'s own, and never frees the reframe family', () => {
  assert.deepEqual(Object.keys(DEFAULT_VOICE_ALLOW).sort(), ['Harley', 'Kiana']);
  assert.deepEqual(kept(KIANA), ['at the end of the day', "He don't love you, he loves the attention.", 'tell me everything']);
  assert.deepEqual(kept(HARLEY), ['Real talk,', 'That part.', 'throw hands', "He don't love you, he loves the attention.", 'tell me everything']);
  assert.equal(kept(EARL).length, FLAGS.length, 'a character with no list is edited as before');
  assert.equal(conversationalRewriteMatches(FLAGS).length, FLAGS.length, 'no body, no licence');
});

test('KADE_VOICE_ALLOW=0 allows nothing; JSON replaces the list; bad JSON allows nothing', () => {
  assert.equal(kept(KIANA, { KADE_VOICE_ALLOW: '0' }).length, FLAGS.length);
  assert.equal(kept(HARLEY, { KADE_VOICE_ALLOW: '0' }).length, FLAGS.length);
  const own = { KADE_VOICE_ALLOW: JSON.stringify({ Kiana: ['that part'], '*': ['look,'] }) };
  assert.deepEqual(kept(KIANA, own), ['Real talk,', 'throw hands', 'at the end of the day', "He don't love you, he loves the attention.", 'tell me everything']);
  assert.deepEqual(kept(EARL, own).includes('Look,'), false, '"*" is everyone');
  assert.equal(kept(HARLEY, own).includes('at the end of the day'), true, 'a JSON list replaces the built-in one');
  assert.equal(kept(KIANA, { KADE_VOICE_ALLOW: 'not json' }).length, FLAGS.length);
});

test('wording the persona itself uses is licensed only with the opt-in switch, for that character only', () => {
  const p = BODY("You're Della.\n\n## 3. How you talk\nYou say real talk when you mean it.");
  const flags = [{ pattern: 'honestly_marker', text: 'real talk,' }];
  assert.equal(conversationalRewriteMatches(flags, p).length, 1);
  assert.equal(conversationalRewriteMatches(flags, p, { KADE_VOICE_ALLOW_PERSONA: '1' }).length, 0);
  assert.equal(conversationalRewriteMatches(flags, EARL, { KADE_VOICE_ALLOW_PERSONA: '1' }).length, 1);
});

test('KADE_CONVERSATION_STYLE_OBSERVE=0 still returns every match untouched', () => {
  assert.equal(conversationalRewriteMatches(FLAGS, KIANA, { KADE_CONVERSATION_STYLE_OBSERVE: '0' }), FLAGS);
});

test('whole-word fixes: got-your-back and mighty/couldn\'t are no longer flagged, the real ones still are', () => {
  const pats = (t) => detectSlop(t, { userText: '' }).matches.map((m) => m.pattern);
  assert.ok(!pats("I've got your back on this one.").includes('blocklist:validation_slop'));
  assert.ok(pats("I've got you.").includes('blocklist:validation_slop'));
  assert.ok(!pats("That's a mighty fine truck, and I couldn't tell you a thing wrong with it.").includes('over_hedging'));
  assert.ok(!pats('I might could get out there Thursday.').includes('over_hedging'), '"might could" is one hedge');
  assert.ok(pats('It might possibly work, maybe.').includes('over_hedging'));
  withEnv({ KADE_SLOP_WORD_BOUNDARY: '0' }, () => {
    assert.ok(pats("I've got your back on this one.").includes('blocklist:validation_slop'));
    assert.ok(pats("That's a mighty fine truck, and I couldn't tell you a thing wrong with it.").includes('over_hedging'));
    assert.ok(pats('I might could get out there Thursday.').includes('over_hedging'));
  });
});

/* ── After the Nov 12 review ───────────────────────────────────────────────── */

test('review: a clause cut whole is a cut, even when the two halves of the contrast are built alike', () => {
  const rest = 'Other words.';
  for (const [before, after] of [
    ["It ain't about the money, it's about respect.", "It's about respect."],
    ["She ain't mad at you, she's mad at herself.", "She's mad at herself."],
    ["That ain't your fault, your boss set you up.", 'Your boss set you up.'],
    ["He ain't being lazy, he's being careful.", "He's being careful."],
    ["You ain't losing your mind, you're losing your patience.", "You're losing your patience."],
    ["It ain't that he don't care, it's that he don't know how to say it.", "He don't know how to say it."],
    ["He's being careful, he ain't being lazy.", "He's being careful."],
  ]) {
    assert.equal(checkEdit(before, after, 'contrast', rest), '', before + ' -> ' + after);
    assert.equal(clauseCut(before, after), true, before);
  }
  // the phrase repair too: the dialect contrast is cut there as its standard twin is
  const text = "It ain't about the money, it's about respect. He knows that.";
  const targets = [{ id: 0, start: 0, end: 45, text: text.slice(0, 45), flags: ['x'] }];
  const out = phrase.applyEdits(text, targets, JSON.stringify({ edits: [{ id: 0, before: text.slice(0, 45), after: "It's about respect." }] }));
  assert.equal(out.status, 'edited');
  assert.equal(out.voiceKept, 0);
  assert.equal(out.text, "It's about respect. He knows that.");
});

test('review: what is not a clause cut still goes to the token test and is refused', () => {
  // one word went, not a clause
  assert.equal(clauseCut('Lord, that boy can eat.', 'That boy can eat.'), false);
  assert.equal(voiceLoss('Lord, that boy can eat.', 'That boy can eat.'), 'lord');
  // a lead-in with no subject and verb of its own
  assert.equal(clauseCut("What the hell, y'all, the truck can't just leave like that.", "The truck can't just leave like that."), false);
  assert.ok(voiceLoss("What the hell, y'all, the truck can't just leave like that.", "The truck can't just leave like that."));
  // a clause went, and a swear went with it from the half that stays
  assert.equal(clauseCut('I get it, that damn truck rattles all night.', 'Truck rattles all night.'), false);
  assert.equal(voiceLoss('I get it, that damn truck rattles all night.', 'Truck rattles all night.'), 'damn');
  // not one unbroken piece of the original
  assert.equal(clauseCut("It ain't about the money, it's about respect.", "It isn't about the money, it's about respect."), false);
  assert.equal(voiceLoss("It ain't about the money, it's about respect.", "It isn't about the money, it's about respect."), "ain't");
  assert.equal(voiceLoss("It ain't about the money, it's about respect.", 'It is not about the money.'), "ain't");
  // the same piece found inside a longer word is not the piece
  assert.equal(clauseCut("She ain't sure, she's guessing.", "He's guessing."), false);
  // nothing cut at all
  assert.equal(clauseCut('He know better.', 'He know better.'), false);
});

test('review: standard English is not read as dialect, so a plain cut around it passes', () => {
  assert.equal(checkEdit('Let me tell you something: the battery is the problem.', "The battery's the problem.", 'setup', 'Other words.'), '');
  assert.equal(checkEdit('What are you going to do now, and where are you going to stay?', 'Where are you going to stay?', 'padding', 'Other words.'), '');
  for (const t of [
    'What are you going to do now, and where are you going to stay?', 'Were they coming to the lake?', "Aren't you going?",
    'Let me tell you something about that pump.', "I'll give you everything I have, and it will cost you nothing.", "I'll call you during lunch.",
    "I'll call you right back.", 'That would drive you crazy.', 'It serves you right.', 'I saw you coming.',
    "Doesn't he know?", "Why can't she go?", "Didn't it look good?",
  ]) assert.deepEqual(voiceTokens(t).map((x) => x.t), [], t);
  // and the real thing is still seen
  assert.deepEqual(voiceTokens('You good? We riding with her.').map((x) => x.t), ['zero-copula', 'zero-copula', 'no-copula']);
  assert.deepEqual(voiceTokens('Oh, he know exactly what he doing out there.').map((x) => x.t).includes('plain-third'), true);
  assert.equal(checkEdit('You good with that plan, or you want another?', 'Are you good with that plan?', 'padding', 'Other words.'), 'voice dropped');
});

test('review: a contraction on a swear or dialect word keeps the word', () => {
  const rest = 'Other words.';
  assert.equal(checkEdit("That shit is broken, and that's the truth of it.", "That shit's broken.", 'maxim', rest), '');
  assert.equal(checkEdit('Asshole is about the messenger.', "Asshole's about the messenger.", 'padding', rest), '');
  assert.equal(checkEdit("Y'all are late again, and that's a fact.", "Y'all're late again.", 'maxim', rest), '');
  assert.deepEqual(voiceTokens("That shit's broken and y'all're late.").map((x) => x.t), ['shit', "y'all"]);
  assert.equal(checkEdit('That shit is broken again.', 'That thing is broken again.', 'padding', rest), 'voice dropped');
});

test('review: a tic somewhere else in the reply does not pay for a second one', () => {
  const rest = 'Honestly, I would let him sleep on the porch all day.';
  assert.equal(checkEdit("Your dog's not ignoring you, he's retired.", "He's just retired, honestly.", 'contrast', rest), 'tic added');
  assert.equal(checkEdit('That is the part of the trip that wears on you.', 'Honestly the trip wears on you.', 'setup', 'I honestly liked the food.'), 'tic added');
  assert.equal(checkEdit('That is the plain fact of it.', "Here's the thing, it is a fact.", 'padding', "Here's the thing about him."), 'tic added');
  // a sentence that had the tic may keep it
  assert.equal(checkEdit('Honestly, the trip wears on you, and that is the whole of it.', 'Honestly, the trip wears on you.', 'maxim', rest), '');
  // phrase repair: the reply opens on the word, the edit may not add another
  const text = 'Honestly, I would not worry. That matters because he is old.';
  const targets = [{ id: 0, start: 29, end: text.length, text: text.slice(29), flags: ['x'] }];
  const raw = JSON.stringify({ edits: [{ id: 0, before: 'That matters because he is old.', after: 'He is old, honestly.' }] });
  const out = phrase.applyEdits(text, targets, raw);
  assert.equal(out.voiceKept, 1);
  assert.equal(out.text, text);
  withEnv({ KADE_VOICE_GUARD: '0' }, () => assert.equal(phrase.applyEdits(text, targets, raw).text, 'Honestly, I would not worry. He is old, honestly.'));
});

test('review: the whole-word rule is for the got-you entries only; entries that work as prefixes still catch', () => {
  const pats = (t) => detectSlop(t, { userText: '' }).matches.map((m) => m.pattern);
  assert.deepEqual(BLOCKLIST.filter((e) => e.whole).map((e) => e.phrase), ["i've got you", 'ive got you']);
  assert.ok(pats('Let me know if you have anything else you need.').includes('blocklist:assistant_register'));
  assert.ok(pats('You two are chaos goblins and I love it.').includes('blocklist:twee_whimsy'));
  assert.ok(pats('You should lean into their strengths.').includes('blocklist:consultant_verb'));
  assert.ok(!pats("I've got your back on this one.").includes('blocklist:validation_slop'));
  // with the switch at 0 the filter is the substring match it was, for every entry
  withEnv({ KADE_SLOP_WORD_BOUNDARY: '0' }, () => {
    assert.ok(pats('Let me know if you have anything else you need.').includes('blocklist:assistant_register'));
    assert.ok(pats("I've got your back on this one.").includes('blocklist:validation_slop'));
  });
});

test('review: a reply stuck printing blank space costs the guard nothing', () => {
  for (const pad of ['\n', ' ', ' \n', '\t']) {
    const stuck = 'Okay.' + pad.repeat(40000) + 'Lord, done.';
    const t0 = Date.now();
    const tokens = voiceTokens(stuck);
    assert.ok(Date.now() - t0 < 2000, 'voiceTokens took ' + (Date.now() - t0) + ' ms on ' + JSON.stringify(pad));
    assert.deepEqual(tokens.map((x) => x.t), ['lord']);
  }
  // positions still line up after the run is folded: the cut is still judged right
  assert.equal(voiceLoss('Lord,\n\n\n   that boy can eat.', 'That boy can eat.'), 'lord');
});

test('the lexicon reads a licence from persona text and counts nothing in standard English', () => {
  assert.deepEqual(licensedWords('You are Harley. Plain talk.'), []);
  assert.deepEqual(licensedWords("Words like yo and hella are yours, and so are ain't, finna and y'all.").sort(), ["ain't", 'finna', 'hella', "y'all", 'yo']);
  assert.equal(voiceTokens('The man said no. I talked to a man.').length, 0);
});
