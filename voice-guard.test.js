'use strict';
/* Nov 12 2026 — tests for the voice guard (voice-lexicon.js in register-edit.js and
 * phrase-repair.js), the editor prompt that no longer teaches "honestly", the "ain't" twin and the
 * per-character allow list (conversation-style.js), and the whole-word filter fixes
 * (slop-filter.js). Run: node --test voice-guard.test.js   (no network, no model) */
const test = require('node:test');
const assert = require('node:assert/strict');
const { voiceLoss, ticAdded, voiceTokens, licensedWords } = require('./voice-lexicon');
const { checkEdit, SYSTEM, SYSTEM_BEFORE_NOV12, systemFor, registerEdit } = require('./register-edit');
const phrase = require('./phrase-repair');
const { conversationalRewriteMatches, DEFAULT_VOICE_ALLOW } = require('./conversation-style');
const { detectSlop } = require('./slop-filter');

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

test('the lexicon reads a licence from persona text and counts nothing in standard English', () => {
  assert.deepEqual(licensedWords('You are Harley. Plain talk.'), []);
  assert.deepEqual(licensedWords("Words like yo and hella are yours, and so are ain't, finna and y'all.").sort(), ["ain't", 'finna', 'hella', "y'all", 'yo']);
  assert.equal(voiceTokens('The man said no. I talked to a man.').length, 0);
});
