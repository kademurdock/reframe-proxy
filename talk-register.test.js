'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  TALK_NOTE, EXPLAIN_NOTE, registerMode, talkRegisterNoteFor,
  TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL,
  TRUST_LISTENER_NOTE, trustListenerNoteFor, SOL_CHARACTER_NOTE,
  KIANA_SOL_REGISTER_NOTE, isKianaSolInstructionBody,
} = require('./talk-register');
const { detectSlop } = require('./slop-filter');
const KIANA_SOL_NOTE = SOL_CHARACTER_NOTE + KIANA_SOL_REGISTER_NOTE;

// Both texts of each note (KADE_CASUAL_HOUSE on and off) and the trust note
// that rides before talk: every one is held to the same rules.
const ALL_NOTES = [TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL, TRUST_LISTENER_NOTE];

const body = (said, extra = {}) => ({ model: 'deepseek/deepseek-v4.1-flash', messages: [
  { role: 'system', content: 'persona' },
  { role: 'user', content: said },
], ...extra });

test('casual turns get the talk note', () => {
  for (const said of [
    'lol he did it AGAIN',
    'my cat knocked the plant over this morning',
    'why would he say that to her though',
    'how was your day',
    'I think UBI is a pipe dream honestly',
    'Mylo is back home from the vet',
    // her complaints about length are conversation (the A/B's misroute)
    'You gave me an essay about not giving an essay',
    'why is everything an essay with you lol',
    'that report card was rough',
  ]) {
    assert.strictEqual(registerMode(body(said)), 'talk', said);
    assert.strictEqual(talkRegisterNoteFor(body(said), {}), TALK_NOTE, said);
  }
});

const kianaBody = (said, model = 'openai/gpt-6.1-sol', extra = {}) => ({
  ...body(said, extra),
  model,
  messages: [
    { role: 'system', content: 'You are Kiana, the flagship intelligence of Kade-AI.' },
    { role: 'user', content: said },
  ],
});

test('Sol Kiana gets expressive conversation for casual and detailed turns without the shortening tail', () => {
  for (const model of ['openai/gpt-6.1-sol', 'gpt-6.1-sol', 'openai/gpt-6.1-sol-20260929']) {
    for (const said of ['lol he did it AGAIN', 'explain why you like that record', 'keep it brief', 'write me a business letter']) {
      const input = kianaBody(said, model);
      assert.strictEqual(talkRegisterNoteFor(input, {}), KIANA_SOL_NOTE);
      assert.strictEqual(trustListenerNoteFor(input, {}), '');
    }
  }
  assert.ok(!SOL_CHARACTER_NOTE.includes('often shorter'));
  assert.ok(!SOL_CHARACTER_NOTE.includes('few sentences'));
  assert.ok(SOL_CHARACTER_NOTE.includes('Honor an explicit request for a brief or quick answer'));
  assert.ok(SOL_CHARACTER_NOTE.includes('audience, tone and format'));
});

test('short interest turns keep room for substance despite an old remembered length reaction', () => {
  for (const said of ['I love how Eminem bends a rhyme.', 'That Outkast song gets me every time.', 'That sounds like a textbook. Tell me why the bass does that.']) {
    const input = kianaBody(said);
    input.messages[0].content += '\nRemembered old reaction: most people prefer shorter replies.';
    assert.strictEqual(registerMode(input), 'talk');
    const note = talkRegisterNoteFor(input, {});
    assert.match(note, /several paragraphs without an explicit request/);
    assert.match(note, /connected tangents and examples/);
    assert.match(note, /message length sets no budget/);
    assert.match(note, /everyday words throughout/);
    assert.match(note, /old reactions or broad assumptions.*never become a standing cap/);
    assert.strictEqual(trustListenerNoteFor(input, {}), '');
    assert.doesNotMatch(note, /often shorter|few sentences|\b\d+\s+words\b/);
  }
});

test('usual Kiana grammar also reaches new people and explanations while retaining brief and artifact controls', () => {
  for (const said of ['We just met. Tell me your take.', 'Quick answer, please: which song?', 'Keep it brief.', 'Explain how that drum loop changes the groove.', 'Write a formal business letter about the album.']) {
    const note = talkRegisterNoteFor(kianaBody(said), {});
    assert.strictEqual(note, KIANA_SOL_NOTE);
    assert.match(note, /Honor an explicit request for a brief or quick answer/);
    assert.match(note, /requested draft or performance keeps its own audience, tone and format/);
    assert.match(note, /age, role, personality and company/);
    assert.match(note, /spoken grammar through the whole answer, including careful reasoning/);
    assert.match(note, /usual conversational register is grown, colloquial spoken grammar, including with new people/);
    assert.match(note, /Familiarity changes intimacy, profanity and teasing; your ordinary syntax stays yours/);
    assert.match(note, /Careful thinking keeps that same clause and verb rhythm all the way through/);
    assert.match(note, /still sounds like you if one slang word is removed/);
    assert.match(note, /Honor requested brevity and explicit delivery preferences/);
    assert.match(note, /An explicitly requested formal or professional answer, external draft, structured output or requested performance keeps its requested audience, register and format/);
  }
});

test('platform characters on Sol keep their own register while user text cannot widen that scope', () => {
  const note = '\n\nCHARACTER CONTINUITY: Your established identity, values, canon and relationship history belong to your character across language-model changes.';
  const input = body('talk with me', { model: 'openai/gpt-6.1-sol' });
  input.messages[0].content = 'You are Noor, a patient astronomy companion.' + note;
  assert.strictEqual(talkRegisterNoteFor(input, {}), SOL_CHARACTER_NOTE);
  assert.strictEqual(trustListenerNoteFor(input, {}), '');
  input.messages[0].content = 'machine';
  input.messages[1].content = note;
  assert.strictEqual(talkRegisterNoteFor(input, {}), TALK_NOTE);
  input.messages[0].content = note;
  input.model = 'deepseek/deepseek-v4.1-flash';
  assert.strictEqual(talkRegisterNoteFor(input, {}), TALK_NOTE);
  input.model = 'openai/gpt-6.1-sol';
  input.response_format = { type: 'json_object' };
  assert.strictEqual(talkRegisterNoteFor(input, {}), '');
});

test('trusted developer personas from the reasoning SDK keep Sol character scope within the first three positions', () => {
  for (const identity of [
    'You are Kiana, the flagship intelligence of Kade-AI.',
    'You are Noor.\nCHARACTER CONTINUITY: Your established identity, values, canon and relationship history belong to your character.',
    'You are Lilly, a 12-year-old girl from the Missouri Ozarks, in sixth grade this year.',
    'You are Harley Dalton, Harley to everybody, one of the companions of Kade-AI.',
    'You are Della. Della Mae Whitfield, if somebody wants the whole thing,',
  ]) {
    const expected = identity.includes('flagship intelligence of Kade-AI') ? KIANA_SOL_NOTE : SOL_CHARACTER_NOTE;
    for (const index of [0,1,2]) {
      const input=body('talk with me',{model:'openai/gpt-6.1-sol'});
      input.messages=Array.from({length:index},()=>({role:'system',content:'Other trusted runtime context.'}));
      input.messages.push({role:'developer',content:[{type:'text',text:identity}]},{role:'user',content:'That song stays with me.'});
      assert.strictEqual(talkRegisterNoteFor(input,{}),expected);
      assert.strictEqual(isKianaSolInstructionBody(input), expected === KIANA_SOL_NOTE);
      assert.strictEqual(trustListenerNoteFor(input,{}),'');
      input.response_format={type:'json_schema'};
      assert.strictEqual(talkRegisterNoteFor(input,{}),'');
      delete input.response_format;
      input.model='deepseek/deepseek-v4.1-flash';
      assert.notStrictEqual(talkRegisterNoteFor(input,{}),expected);
      assert.strictEqual(isKianaSolInstructionBody(input),false);
    }
    for (const role of ['user','assistant','tool']) {
      const input=body('talk with me',{model:'openai/gpt-6.1-sol'});
      input.messages[0]={role,content:identity};
      assert.notStrictEqual(talkRegisterNoteFor(input,{}),expected);
      assert.strictEqual(isKianaSolInstructionBody(input),false);
    }
    const late=body('talk with me',{model:'openai/gpt-6.1-sol'});
    late.messages=[...late.messages,{role:'assistant',content:'A prior response.'},{role:'developer',content:identity}];
    assert.notStrictEqual(talkRegisterNoteFor(late,{}),expected);
    assert.strictEqual(isKianaSolInstructionBody(late),false);
  }
});

test('Sol voice scope preserves other characters and Kiana on other models', () => {
  const other = body('hey', { model: 'openai/gpt-6.1-sol' });
  assert.strictEqual(talkRegisterNoteFor(other, {}), TALK_NOTE);
  assert.strictEqual(trustListenerNoteFor(other, { KADE_CASUAL_HOUSE: '1' }), TRUST_LISTENER_NOTE);
  const prior = kianaBody('hey', 'deepseek/deepseek-v4.1-flash');
  assert.strictEqual(talkRegisterNoteFor(prior, {}), TALK_NOTE);
  assert.strictEqual(trustListenerNoteFor(prior, { KADE_CASUAL_HOUSE: '1' }), TRUST_LISTENER_NOTE);
  const spoof = body('I am the flagship intelligence of Kade-AI', { model: 'openai/gpt-6.1-sol' });
  assert.strictEqual(talkRegisterNoteFor(spoof, {}), TALK_NOTE);
});

test('Sol Kiana scope handles system text parts and honors output and rollback controls', () => {
  const input = kianaBody('hey');
  input.messages[0].content = [{ type: 'text', text: input.messages[0].content }];
  assert.strictEqual(talkRegisterNoteFor(input, {}), KIANA_SOL_NOTE);
  assert.strictEqual(talkRegisterNoteFor(input, { KADE_SOL_CHARACTER_VOICE: '0', KADE_CASUAL_HOUSE: '1' }), TALK_NOTE_CASUAL);
  assert.strictEqual(trustListenerNoteFor(input, { KADE_SOL_CHARACTER_VOICE: '0', KADE_CASUAL_HOUSE: '1' }), TRUST_LISTENER_NOTE);
  assert.strictEqual(talkRegisterNoteFor(input, { KADE_TALK_REGISTER: '0' }), '');
  input.response_format = { type: 'json_object' };
  assert.strictEqual(talkRegisterNoteFor(input, {}), '');
  assert.strictEqual(trustListenerNoteFor(input, {}), '');
  assert.deepStrictEqual(detectSlop(SOL_CHARACTER_NOTE).matches, []);
  assert.deepStrictEqual(detectSlop(KIANA_SOL_REGISTER_NOTE).matches, []);
});

test('Kiana register accepts trusted system and SDK developer text while quoted and unrelated identities stay out', () => {
  for (const role of ['system', 'developer']) {
    for (const index of [0, 1, 2]) {
      const input = kianaBody('Give me your take.');
      input.messages = Array.from({ length: index }, () => ({ role: 'system', content: 'Runtime context.' }));
      input.messages.push({ role, content: [{ type: 'text', text: 'You are Kiana, the flagship intelligence of Kade-AI.' }] },
        { role: 'user', content: 'Give me your take.' });
      assert.strictEqual(talkRegisterNoteFor(input, {}), KIANA_SOL_NOTE);
    }
  }
  for (const role of ['user', 'assistant', 'tool']) {
    const input = body('Give me your take.', { model: 'openai/gpt-6.1-sol' });
    input.messages[0] = { role, content: 'You are Kiana, the flagship intelligence of Kade-AI.' };
    assert.strictEqual(isKianaSolInstructionBody(input), false);
    assert.strictEqual(talkRegisterNoteFor(input, {}).includes(KIANA_SOL_REGISTER_NOTE), false);
  }
  for (const identity of ['You are Kiana, an unrelated fictional persona.', 'You generate conversation titles.']) {
    const input = body('Give me your take.', { model: 'openai/gpt-6.1-sol' });
    input.messages[0] = { role: 'developer', content: identity };
    assert.strictEqual(isKianaSolInstructionBody(input), false);
    assert.strictEqual(talkRegisterNoteFor(input, {}).includes(KIANA_SOL_REGISTER_NOTE), false);
  }
});

test('Lilly, Harley and Della keep their own voice with room, without Kiana slang instructions', () => {
  for (const opening of [
    'You are Lilly, a 12-year-old girl from the Missouri Ozarks, in sixth grade this year.',
    'You are Harley Dalton, Harley to everybody, one of the companions of Kade-AI.',
    'You are Della. Della Mae Whitfield, if somebody wants the whole thing,',
  ]) {
    const input = body('ramble with me', { model: 'openai/gpt-6.1-sol' });
    input.messages[0].content = opening;
    assert.strictEqual(talkRegisterNoteFor(input, {}), SOL_CHARACTER_NOTE);
    assert.strictEqual(isKianaSolInstructionBody(input), false);
    assert.strictEqual(trustListenerNoteFor(input, {}), '');
    assert.strictEqual(talkRegisterNoteFor(input, { KADE_SOL_CHARACTER_VOICE: '0' }), TALK_NOTE);
    input.messages[0].content = '# Character — System Prompt\n\n## Who You Are\n\n' + opening;
    assert.strictEqual(talkRegisterNoteFor(input, {}), SOL_CHARACTER_NOTE);
    input.messages[0].content = [{ type: 'text', text: input.messages[0].content }];
    assert.strictEqual(talkRegisterNoteFor(input, {}), SOL_CHARACTER_NOTE);
  }
  assert.ok(!SOL_CHARACTER_NOTE.includes('fuck'));
  assert.ok(!SOL_CHARACTER_NOTE.includes('hellas'));
  assert.ok(SOL_CHARACTER_NOTE.includes('age, role, personality'));
});

test('private Lilly and unrelated same-name personas keep their existing register', () => {
  for (const opening of [
    "You are Lilly, a 12-year-old girl and Skylee's best friend.",
    'You are Harley, an unrelated character.',
    'You are Della, an unrelated character.',
  ]) {
    const input = body('hello', { model: 'openai/gpt-6.1-sol' });
    input.messages[0].content = '# Persona\n\n' + opening;
    assert.strictEqual(talkRegisterNoteFor(input, {}), TALK_NOTE);
    assert.strictEqual(trustListenerNoteFor(input, { KADE_CASUAL_HOUSE: '1' }), TRUST_LISTENER_NOTE);
  }
});

test('plain requests for depth get the explain note', () => {
  for (const said of [
    'can you explain how a disk stores data',
    'walk me through setting up the router',
    'how does a heat pump work',
    'how do I get the library to play in the background',
    "what's the difference between a cassette and a reel to reel",
    'give me the five-minute version of the Civil War',
    'write me a poem about my dog',
    'can you look it up for me',
    'pros and cons of moving to Springfield',
    'summarize this article for me',
    'give me a rundown of the new tax rules',
    'write me an essay on the Ozarks',
    'the history of KWTO radio',
  ]) {
    assert.strictEqual(registerMode(body(said)), 'explain', said);
    assert.strictEqual(talkRegisterNoteFor(body(said), {}), EXPLAIN_NOTE, said);
  }
});

test('the latest human message decides, not older ones or pasted blocks', () => {
  const b = { messages: [
    { role: 'user', content: 'explain quantum computing' },
    { role: 'assistant', content: 'Sure...' },
    { role: 'user', content: 'ha, okay that was a lot' },
  ] };
  assert.strictEqual(registerMode(b), 'talk');
  assert.strictEqual(registerMode(body('look at this ```the manual says explain the steps```')), 'talk');
  assert.strictEqual(registerMode(body([{ type: 'text', text: 'teach me to knit' }])), 'explain');
});

test('kill switch, structured output and odd bodies', () => {
  assert.strictEqual(talkRegisterNoteFor(body('hey'), { KADE_TALK_REGISTER: '0' }), '');
  assert.strictEqual(talkRegisterNoteFor(body('hey', { response_format: { type: 'json_object' } }), {}), '');
  assert.strictEqual(talkRegisterNoteFor(null, {}), '');
  assert.strictEqual(talkRegisterNoteFor({}, {}), TALK_NOTE);
});

test('the notes read clean on the platform\'s own detector (never demonstrate a banned shape)', () => {
  for (const note of ALL_NOTES) {
    const found = detectSlop(note).matches.map(m => m.pattern + ': ' + m.text);
    assert.deepStrictEqual(found, [], found.join('; '));
  }
});

test('the notes quote none of the shapes they steer away from', () => {
  const quotedShapes = [
    /the part (?:where|that)/i, /here'?s the thing/i, /what matters/i, /the whole [a-z]+/i,
    /that'?s the [a-z]+\./i, /wearing [a-z]+'?s? clothes/i, /same [a-z]+, different/i,
    /isn'?t [a-z]+[.,] (?:it'?s|that'?s)/i, /not [a-z]+, but/i, /i don'?t know\./i, /i wanna know/i,
    // no contrast-by-denial in the note's own sentences either (", not X" / "never in X")
    /, not (?:a |an |the )?[a-z]+/i, /\bnever in\b/i,
    /"[^"]+"/, /“[^”]+”/,
  ];
  for (const note of ALL_NOTES) {
    for (const re of quotedShapes) assert.ok(!re.test(note), re + ' in note: ' + note.slice(0, 40));
  }
});

test('the notes stay short (a long note is the thing it warns against)', () => {
  const words = note => note.trim().split(/\s+/).length;
  for (const note of [TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL]) {
    assert.ok(words(note) <= 170, 'talk note words: ' + words(note));
  }
  for (const note of [EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL]) {
    assert.ok(words(note) <= 90, 'explain note words: ' + words(note));
  }
});

test('the note rides LAST in the tail, after the conversation guidance and the trust note', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const line = src.split('\n').find(l => l.includes('talkRegisterNoteFor(body)') && l.includes('guidance.conversation'));
  assert.ok(line, 'tail line found');
  assert.ok(/guidance\.conversation : ''\) \+ trustListenerNoteFor\(body\) \+ talkRegisterNoteFor\(body\) \}\]/.test(line),
    'trust rides right before the talk note, and the talk note is the final piece');
});

test('trust the listener rides only with the casual house, only where the talk note rides', () => {
  const on = { KADE_CASUAL_HOUSE: '1' };
  const off = { KADE_CASUAL_HOUSE: '0' };
  for (const said of ['lol he did it AGAIN', 'how was your day', 'You gave me an essay about not giving an essay']) {
    assert.strictEqual(trustListenerNoteFor(body(said), on), TRUST_LISTENER_NOTE, said);
    assert.strictEqual(talkRegisterNoteFor(body(said), on), TALK_NOTE_CASUAL, said);
    assert.strictEqual(trustListenerNoteFor(body(said), off), '', said);
    assert.strictEqual(talkRegisterNoteFor(body(said), off), TALK_NOTE_CLASSIC, said);
  }
  for (const said of ['can you explain how a disk stores data', 'write me a poem about my dog', 'pros and cons of moving to Springfield']) {
    assert.strictEqual(trustListenerNoteFor(body(said), on), '', 'explain turns never get it: ' + said);
    assert.strictEqual(talkRegisterNoteFor(body(said), on), EXPLAIN_NOTE_CASUAL, said);
    assert.strictEqual(talkRegisterNoteFor(body(said), off), EXPLAIN_NOTE_CLASSIC, said);
  }
  assert.strictEqual(trustListenerNoteFor(body('hey'), { ...on, KADE_TALK_REGISTER: '0' }), '', 'no talk note, no trust note');
  assert.strictEqual(trustListenerNoteFor(body('hey', { response_format: { type: 'json_object' } }), on), '');
  assert.strictEqual(trustListenerNoteFor(null, on), '');
  assert.notStrictEqual(TALK_NOTE_CASUAL, TALK_NOTE_CLASSIC);
  assert.notStrictEqual(EXPLAIN_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC);
  assert.ok([TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL].includes(TALK_NOTE), 'the export is one of the two texts');
  assert.ok([EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL].includes(EXPLAIN_NOTE));
});
