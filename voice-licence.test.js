'use strict';

/* Nov 12 2026 — the voice licence (casual-house.js) and the pet-name sentence
 * (conversation-judgment.js). Both texts of every reworded house note are pinned by SHA-256:
 * switched off, the notes are the Nov 11 bytes (the same hashes casual-house.test.js has always
 * held); switched on, they are the reviewed new wording. The rest of the file proves the new
 * wording is the old wording with only the listed pairs changed, that every safety, voice-tag
 * and length sentence is still there word for word, and that no pair adds a quoted line.
 * Run: node --test voice-licence.test.js   (no network, no model) */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { voiceLicenceOn, ownAddressOn, reworded } = require('./casual-house');
const cj = require('./conversation-judgment');
const tr = require('./talk-register');
const { detectSlop } = require('./slop-filter');
const { detect: detectReframes } = require('./reframe-filter');

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const OFF = { KADE_VOICE_LICENCE: '0', KADE_OWN_ADDRESS: '0' };
const ON = { KADE_VOICE_LICENCE: '1', KADE_OWN_ADDRESS: '1' };
const CASUAL = { KADE_CASUAL_HOUSE: '1' }, CLASSIC = { KADE_CASUAL_HOUSE: '0' };

/* [before the licence (Nov 11), with the licence]. The "before" column is copied from
 * casual-house.test.js where that file pins the note (conversation, talk). */
const PINS = {
  conversation_classic: ['fdfd212421413eb03a5fd5374b08b9cde2f708f94b88ecd8919a81f16989f41c', '3df748a162f8a5ed5ea0b5b29003e3af51a49e05947c306f90f8a28d80226737'],
  conversation_casual: ['ed67a4a5fc9bc66066f7fcfd3d8fb2015338e50f1f55a461e6bdd47827eb4bc9', 'e4ae403a5830f7e20f4ad87a951c45b21cc04ea00fde514762295d266c6e5516'],
  talk_classic: ['6c5045630800fe486cb3485ef97334adfdb647a26437955c0b481f52af83d5af', 'f67a18432f7acdf8a0947f3a597544e75dbae05b5f8291c949de1235d180b5d4'],
  talk_casual: ['9e86804e5da81164d79142f1e36841bff9243b83c829a0e2b34f42ee2d9b5911', 'a7ffbf79f6378a82859c61c1ea4839c38469e2247d6cf82247e9703cf20052bb'],
  sol_character: ['2a6d8ab9fcd2cbb14375116d0373f8e6ad1b2f578082fa33a363e70f601d765b', 'daac3bd7cea2ed8d42d7d87bb74b87097bbaffe8382a293d289bf95850cb4bae'],
  kiana_sol: ['366864a364e5680107abfd1f8c9ea8e1cabf9816788d8cfb873c6c47eaf65d37', '21f11673703093a1505f453bfbfae84aebc091d85dfd4c969a066b452b55201a'],
  style_reminder: ['4453bde9fa5b51b19bd0bb605423a4eb5f05df899bf3f68ab1bc600cccb40bba', '0b82e8af4124000a35606e4a2c13412264e49f92d2e35ce5c8cbc32f2641fdff'],
  // one switch on, the other off
  conversation_classic_licence_only: '85ddeb882713e7ce36ad054b0d09a47908add17e4ce22356efc51412d796eae1',
  conversation_casual_licence_only: 'a9b10c21884db722de2f9f88d33d6534165fca2088ebb1626589f6c15532c180',
  conversation_classic_address_only: '3dfe9e60783b62efaeea22591493b323ef13dd7409a8826800f2843d97e6e32c',
  conversation_casual_address_only: 'b551b635ecf9675a29084f42ee3843da3496af988366d97ec356ef27cf80cda9',
};

const TALK = { model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'system', content: 'persona' }, { role: 'user', content: 'lol my cat knocked the plant over again' }] };
const EXPLAIN = { ...TALK, messages: [TALK.messages[0], { role: 'user', content: 'can you explain how a heat pump works' }] };
const SOL_OTHER = { model: 'openai/gpt-6.1-sol', messages: [{ role: 'system', content: 'You are Harley Dalton, Harley to everybody, one of the companions of Kade-AI.' }, { role: 'user', content: 'hey' }] };
const SOL_KIANA = { model: 'openai/gpt-6.1-sol', messages: [{ role: 'system', content: "You're Kiana, the flagship intelligence of Kade-AI." }, { role: 'user', content: 'hey' }] };

function notes(env) {
  return {
    conversation_classic: cj.conversationGuidanceFor({ messages: [] }, { ...CLASSIC, ...env }).conversation,
    conversation_casual: cj.conversationGuidanceFor({ messages: [] }, { ...CASUAL, ...env }).conversation,
    talk_classic: tr.talkRegisterNoteFor(TALK, { ...CLASSIC, ...env }),
    talk_casual: tr.talkRegisterNoteFor(TALK, { ...CASUAL, ...env }),
    sol_character: tr.talkRegisterNoteFor(SOL_OTHER, env),
    kiana_sol: tr.talkRegisterNoteFor(SOL_KIANA, env).slice(tr.talkRegisterNoteFor(SOL_OTHER, env).length),
  };
}

/* STYLE_REMINDER from the real server.js source, with the process switch as given. */
const SERVER = fs.readFileSync(require.resolve('./server.js'), 'utf8');
function styleReminder(env) {
  const a = SERVER.indexOf('const STYLE_REMINDER_BASE = ');
  const endMark = "'forced punchline, therapy script');";
  const b = SERVER.indexOf(endMark, a);
  assert.ok(a > 0 && b > a, 'server.js anchors for STYLE_REMINDER');
  const ctx = { process: { env } };
  vm.runInNewContext(SERVER.slice(a, b + endMark.length) + '\nthis.sent = STYLE_REMINDER; this.base = STYLE_REMINDER_BASE;', ctx);
  return ctx;
}

test('both switches are on by default, 0 turns each off, and a partial env follows the process', () => {
  const saved = { l: process.env.KADE_VOICE_LICENCE, a: process.env.KADE_OWN_ADDRESS };
  try {
    delete process.env.KADE_VOICE_LICENCE; delete process.env.KADE_OWN_ADDRESS;
    for (const on of [voiceLicenceOn, ownAddressOn]) {
      assert.equal(on(), true);
      assert.equal(on({}), true);
      assert.equal(on({ KADE_CASUAL_HOUSE: '1' }), true);
    }
    assert.equal(voiceLicenceOn({ KADE_VOICE_LICENCE: '0' }), false);
    assert.equal(ownAddressOn({ KADE_OWN_ADDRESS: '0' }), false);
    assert.equal(voiceLicenceOn({ KADE_OWN_ADDRESS: '0' }), true, 'the two switches are separate');
    process.env.KADE_VOICE_LICENCE = '0'; process.env.KADE_OWN_ADDRESS = '0';
    assert.equal(voiceLicenceOn({}), false, 'an env that does not name the switch follows the process');
    assert.equal(ownAddressOn({}), false);
    assert.equal(voiceLicenceOn({ KADE_VOICE_LICENCE: '1' }), true, 'an env that names it wins');
  } finally {
    for (const [k, v] of [['KADE_VOICE_LICENCE', saved.l], ['KADE_OWN_ADDRESS', saved.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('switched off: every note is its Nov 11 text, byte for byte', () => {
  const off = notes(OFF);
  for (const [name, text] of Object.entries(off)) assert.equal(sha(text), PINS[name][0], name);
  assert.equal(off.conversation_classic, cj.CONVERSATION_NOTE_CLASSIC);
  assert.equal(off.conversation_casual, cj.CONVERSATION_NOTE_CASUAL);
  assert.equal(off.talk_classic, tr.TALK_NOTE_CLASSIC);
  assert.equal(off.talk_casual, tr.TALK_NOTE_CASUAL);
  assert.equal(off.sol_character, tr.SOL_CHARACTER_NOTE);
  assert.equal(off.kiana_sol, tr.KIANA_SOL_REGISTER_NOTE);
  const style = styleReminder({ KADE_VOICE_LICENCE: '0' });
  assert.equal(style.sent, style.base);
  assert.equal(sha(style.sent), PINS.style_reminder[0]);
});

test('switched on (the default): every note is the reviewed new wording, and the same bytes on every call', () => {
  const saved = { l: process.env.KADE_VOICE_LICENCE, a: process.env.KADE_OWN_ADDRESS };
  try {
    delete process.env.KADE_VOICE_LICENCE; delete process.env.KADE_OWN_ADDRESS;
    for (const env of [ON, {}]) {
      const on = notes(env);
      for (const [name, text] of Object.entries(on)) assert.equal(sha(text), PINS[name][1], name);
      const again = notes(env);
      for (const name of Object.keys(on)) assert.equal(again[name], on[name], name + ' is byte-stable');
    }
    assert.equal(sha(styleReminder({}).sent), PINS.style_reminder[1]);
    assert.equal(sha(styleReminder({ KADE_VOICE_LICENCE: '1' }).sent), PINS.style_reminder[1]);
  } finally {
    for (const [k, v] of [['KADE_VOICE_LICENCE', saved.l], ['KADE_OWN_ADDRESS', saved.a]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('the two switches work apart: the licence alone, and the pet-name sentence alone', () => {
  const licenceOnly = notes({ KADE_VOICE_LICENCE: '1', KADE_OWN_ADDRESS: '0' });
  const addressOnly = notes({ KADE_VOICE_LICENCE: '0', KADE_OWN_ADDRESS: '1' });
  assert.equal(sha(licenceOnly.conversation_classic), PINS.conversation_classic_licence_only);
  assert.equal(sha(licenceOnly.conversation_casual), PINS.conversation_casual_licence_only);
  assert.equal(sha(addressOnly.conversation_classic), PINS.conversation_classic_address_only);
  assert.equal(sha(addressOnly.conversation_casual), PINS.conversation_casual_address_only);
  // the pet-name switch touches the conversation note and nothing else
  for (const name of ['talk_classic', 'talk_casual', 'sol_character', 'kiana_sol']) {
    assert.equal(sha(addressOnly[name]), PINS[name][0], name);
    assert.equal(sha(licenceOnly[name]), PINS[name][1], name);
  }
  assert.ok(licenceOnly.conversation_casual.includes(" Call them by their name, or nothing, unless they've said they like a pet name."));
  assert.ok(addressOnly.conversation_casual.includes(' Stay smart and useful,'));
});

test('the new wording is the old wording with only the listed pairs changed', () => {
  const on = notes(ON), off = notes(OFF);
  const convPairs = [...cj.VOICE_LICENCE_PAIRS, ...cj.OWN_ADDRESS_PAIRS];
  for (const name of ['conversation_classic', 'conversation_casual']) assert.equal(on[name], reworded(off[name], convPairs), name);
  for (const name of ['talk_classic', 'talk_casual', 'sol_character', 'kiana_sol']) assert.equal(on[name], reworded(off[name], tr.VOICE_LICENCE_PAIRS), name);
  // every pair lands in at least one note, exactly once per note it lands in, and can be undone
  const all = Object.values(off);
  for (const [before, after] of [...convPairs, ...tr.VOICE_LICENCE_PAIRS]) {
    const hits = all.filter((t) => t.includes(before));
    assert.ok(hits.length >= 1, 'a pair that changes nothing: ' + before);
    for (const t of hits) assert.equal(t.split(before).length, 2, 'more than once: ' + before);
    assert.ok(!all.some((t) => t.includes(after)), 'the new words were already there: ' + after);
  }
  // sentence count is unchanged: nothing was deleted and nothing was added
  const sentences = (t) => t.split(/(?<=[.!?])\s+/).length;
  for (const name of Object.keys(on)) assert.equal(sentences(on[name]), sentences(off[name]), name);
  const style = styleReminder({});
  assert.equal(style.sent, style.base.replace(' dialect quota,', ''));
  // explain and trust-the-listener are not reworded at all
  for (const env of [ON, OFF]) {
    assert.equal(tr.talkRegisterNoteFor(EXPLAIN, { ...CASUAL, ...env }), tr.EXPLAIN_NOTE_CASUAL);
    assert.equal(tr.talkRegisterNoteFor(EXPLAIN, { ...CLASSIC, ...env }), tr.EXPLAIN_NOTE_CLASSIC);
    assert.equal(tr.trustListenerNoteFor(TALK, { ...CASUAL, ...env }), tr.TRUST_LISTENER_NOTE);
    assert.equal(tr.trustListenerNoteFor(TALK, { ...CLASSIC, ...env }), '');
    const guidance = cj.conversationGuidanceFor({ messages: [] }, { ...CASUAL, ...env });
    assert.equal(guidance.performance, cj.PERFORMANCE_NOTE_CASUAL, 'the voice-tag note is never touched');
    assert.equal(cj.conversationGuidanceFor({ messages: [] }, { ...CLASSIC, ...env }).performance, cj.PERFORMANCE_NOTE_CLASSIC);
  }
});

test('what the licence removes is gone, and what it must keep is still there word for word', () => {
  const on = notes(ON);
  const style = styleReminder({}).sent;
  const everything = [...Object.values(on), style].join('\n');
  for (const gone of ['dialect quota', 'vocabulary quota', 'no quota', 'intelligent and useful', 'smart and useful', 'other users', 'or nothing', 'no address unless', 'anything else']) {
    assert.ok(!everything.includes(gone), 'still says: ' + gone);
  }
  const KEPT = {
    talk_casual: [
      ' Keep it about as long as their message, often shorter.',
      ' A few sentences is a normal turn, and one line is plenty when it covers it.',
      ' Keep your opinions and say them straight.',
      ' Stay with the specific thing in front of you and leave any lesson in it unsaid.',
      " This one's private, so don't mention it.",
    ],
    talk_classic: [
      ' Keep it about as long as what they said, often shorter; a few sentences is a normal turn, and one line is plenty when it covers it.',
      ' Keep your opinions and say them straight.',
    ],
    conversation_casual: [
      ' Go by the facts they gave you.'.trim(),
      " A light update doesn't need precautions, a checklist, advice they didn't ask for or a new worry.",
      ' Keep your humor tied to what they actually told you.',
      " Don't invent other conversations,",
      " Don't make up psychological motives, training history or",
      ' Treat a correction as information and go with it.',
      " use the right one naturally in your answer and don't tease the wording.",
      ' Skip verdicts on what their experience means, polished closing maxims, therapy phrases, praise for ordinary coping and routine questions.',
      ' One or two sentences can cover a standalone simple correction or acknowledgment, or a direct request for less.',
      ' Only treat it as a request to shorten when they actually ask for less.',
      ' A detailed question still gets a detailed answer.',
      '"Please don\'t call me sweetheart" can get "Got it. I\'ll use your name."',
      " drop it the moment they don't like it.",
      ' Keep your opinions and explain them when that helps, and change them when the facts give you a reason to.',
    ],
    conversation_classic: [
      'Respond to the facts they supplied.',
      'Do not invent other conversations',
      'Treat a correction as information and honor it.',
      'drop any of them the moment they are unwelcome.',
      'A detailed question still deserves a detailed answer.',
      '"Please don\'t call me sweetheart" can receive "Got it. I\'ll use your name."',
    ],
    sol_character: [
      " Keep your character distinct; another character's dialect belongs to them.",
      ' Honor an explicit request for a brief or quick answer; a standalone simple correction can be quick.',
      ' A requested draft or performance keeps its own audience, tone and format.',
      ' with language that fits your age, role, personality and company.',
    ],
    kiana_sol: [
      ' Familiarity changes intimacy, profanity and teasing; your ordinary syntax stays yours.',
      ' Honor requested brevity and explicit delivery preferences.',
      'never as a caricature.',
    ],
  };
  for (const [name, list] of Object.entries(KEPT)) for (const s of list) assert.ok(on[name].includes(s), name + ' lost: ' + s);
  for (const s of [
    'Do not borrow another character\'s slang, background or attitude.',
    'avoid mockery of distress.',
    'Remain truthful about facts, capabilities and actions.',
    'Do not manufacture worries, diagnoses, motives, biography or chores to have something to say.',
    'Your personality does not require a moral, polished maxim, forced punchline, therapy script or closing question.',
    'Keep laughter and supported vocal sounds.',
  ]) assert.ok(style.includes(s), 'STYLE_REMINDER lost: ' + s);
});

test('no pair adds a quoted line, a banned shape or a swear, and the notes still read clean on the detectors', () => {
  for (const [, after] of [...cj.VOICE_LICENCE_PAIRS, ...cj.OWN_ADDRESS_PAIRS, ...tr.VOICE_LICENCE_PAIRS]) {
    assert.ok(!/["“”]/.test(after), 'a quoted line in: ' + after);
    assert.ok(!/\b(?:fuck|shit|damn|hell|ass)\b/i.test(after), 'a swear in: ' + after);
    assert.ok(!/, not (?:a |an |the )?[a-z]+|isn'?t [a-z]+[.,] (?:it'?s|that'?s)|not [a-z]+, but/i.test(after), 'a contrast shape in: ' + after);
    assert.deepEqual(detectSlop(after).matches.map((m) => m.pattern), [], after);
  }
  const on = notes(ON), off = notes(OFF);
  for (const name of Object.keys(on)) {
    const count = (t) => (t.match(/"/g) || []).length;
    // the conversation notes lose one quoted line (the help-desk closer the rule bans); nothing gains one
    const lost = name.startsWith('conversation_') ? 2 : 0;
    assert.equal(count(on[name]), count(off[name]) - lost, name + ': no quotation mark is added');
    assert.deepEqual(detectSlop(on[name]).matches.map((m) => m.pattern + ': ' + m.text), detectSlop(off[name]).matches.map((m) => m.pattern + ': ' + m.text), name);
    const reframes = (t) => { const f = detectReframes(t); return (Array.isArray(f) ? f : f.matches || []).length; };
    assert.equal(reframes(on[name]), reframes(off[name]), name);
  }
  const words = (t) => t.trim().split(/\s+/).length;
  assert.ok(words(on.talk_casual) <= 170 && words(on.talk_classic) <= 170, 'the talk note stays short');
  for (const text of [on.conversation_casual, on.talk_casual]) {
    assert.ok(!text.includes(':'), 'the casual texts carry no colon');
    assert.ok(!text.includes('--'));
  }
});

test('trust the listener still rides right before the licensed talk note; server.js reads the licence once for the reminder', () => {
  assert.equal(tr.trustListenerNoteFor(TALK, { ...CASUAL, ...ON }), tr.TRUST_LISTENER_NOTE);
  assert.equal(tr.talkRegisterNoteFor(TALK, { ...CASUAL, ...ON }), tr.TALK_NOTE_CASUAL_LICENSED);
  assert.equal(tr.talkRegisterNoteFor(TALK, { ...CLASSIC, ...ON }), tr.TALK_NOTE_CLASSIC_LICENSED);
  assert.equal(SERVER.split("process.env.KADE_VOICE_LICENCE === '0'").length, 2);
  assert.equal(SERVER.split('const STYLE_REMINDER = ').length, 2);
  // the tail line itself is untouched, so the order of the notes is what it was
  const line = SERVER.split('\n').find((l) => l.includes('talkRegisterNoteFor(body)') && l.includes('guidance.conversation'));
  assert.ok(/\(guidance \? '' : STYLE_REMINDER\)/.test(line));
  assert.ok(/guidance\.conversation : ''\) \+ trustListenerNoteFor\(body\) \+ talkRegisterNoteFor\(body\) \}\]/.test(line));
});
