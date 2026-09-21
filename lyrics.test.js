'use strict';
/* jev.js reads TYPESAFE_API_KEY into a module-level const at load, so the key
 * has to be here, above the requires, for the learner tests below to exercise
 * the real path rather than the disabled one. */
process.env.TYPESAFE_API_KEY = process.env.TYPESAFE_API_KEY || 'apikey_test';
delete process.env.KADE_JEV;
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
test("the Sound Booth song desk is the lyric lane too, so no chat guard rewrites a song", () => {
  const desk = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth. Your saved persona below is who you are in conversation.";
  assert.equal(isLyricBody({ messages: [{ role: 'system', content: desk }, { role: 'user', content: 'WHAT THEY WANT MADE:\na slow harp song' }] }), true);
  assert.equal(isLyricBody({ messages: [{ role: 'user', content: desk }] }), false);
});

/* ── Part 239: the learned lane ────────────────────────────────────────── */
const { learnLyricBody, _internals } = require('./lyrics');
const SONG_DESK = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth.";

const withKey = (fn) => fn();
const settle = () => new Promise((r) => setTimeout(r, 0));

test('a changed desk prompt is learned once and protects every turn after it', async () => {
  _internals.learned.clear();
  /* The real fault: the fork edits its opening line, so neither prefix hits. */
  const changed = 'You are Lyric, songwriting desk, Sound Booth. Write the song, verses and chorus.';
  const body = { messages: [{ role: 'system', content: changed }] };
  assert.equal(isLyricBody(body), false, 'the first turn is unprotected, exactly as today');
  let asked = null;
  await withKey(async () => {
    learnLyricBody(body, { ask: async (state, questions) => { asked = { state, questions }; return { answers: { lyric: { noul: 0.93 } } }; }, log: { log() {} } });
    await settle(); await settle();
  });
  assert.ok(asked, 'it asked');
  assert.equal(asked.state.prompt, changed);
  assert.equal(isLyricBody(body), true, 'and every turn after it is protected');
});

test('the learner can only ever turn protection ON', async () => {
  _internals.learned.clear();
  const real = { messages: [{ role: 'system', content: SONG_DESK + ' Write three verses.' }] };
  assert.equal(isLyricBody(real), true);
  await withKey(async () => {
    /* Even a flat NO cannot unprotect a body the prefixes already matched. */
    learnLyricBody(real, { ask: async () => ({ answers: { lyric: { noul: 0.0 } } }), log: { log() {} } });
    await settle(); await settle();
  });
  assert.equal(isLyricBody(real), true);
});

test('a low answer teaches nothing, and a failure teaches nothing', async () => {
  _internals.learned.clear();
  const body = { messages: [{ role: 'system', content: 'You are a music critic. Discuss songs and verses with the listener at length.' }] };
  await withKey(async () => {
    learnLyricBody(body, { ask: async () => ({ answers: { lyric: { noul: 0.2 } } }), log: { log() {} } });
    await settle(); await settle();
  });
  assert.equal(isLyricBody(body), false, 'talking about songs is not writing them');
  await withKey(async () => {
    learnLyricBody(body, { ask: async () => { throw new Error('HTTP 500'); }, log: { log() {} } });
    await settle(); await settle();
  });
  assert.equal(isLyricBody(body), false);
});

test('the pre-filter keeps ordinary chat away from the question entirely', async () => {
  _internals.learned.clear();
  let asked = 0;
  const ordinary = { messages: [{ role: 'system', content: 'You are Kiana, a warm friend from the Ozarks who remembers what matters to the people she talks to.' }] };
  await withKey(async () => {
    learnLyricBody(ordinary, { ask: async () => { asked++; return { answers: { lyric: { noul: 0.9 } } }; }, log: { log() {} } });
    await settle();
  });
  assert.equal(asked, 0, 'no songwriting words in the prompt, so no call and no cost');
  /* And a short prompt is not worth asking about either. */
  await withKey(async () => {
    learnLyricBody({ messages: [{ role: 'system', content: 'song' }] }, { ask: async () => { asked++; return { answers: {} }; }, log: { log() {} } });
    await settle();
  });
  assert.equal(asked, 0);
});

test('the learner is off when the switch is off', async () => {
  _internals.learned.clear();
  let asked = 0;
  process.env.KADE_JEV_LYRIC_LANE = '0';
  await withKey(async () => {
    learnLyricBody({ messages: [{ role: 'system', content: 'Write the song. Verses, chorus, hook, the lot, as a songwriter would.' }] },
      { ask: async () => { asked++; return { answers: {} }; }, log: { log() {} } });
    await settle();
  });
  delete process.env.KADE_JEV_LYRIC_LANE;
  assert.equal(asked, 0);
});
