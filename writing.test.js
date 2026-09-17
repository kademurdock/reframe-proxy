'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { writingDeskFor, WRITING_STYLE_NOTE } = require('./writing');
const { LYRIC_OUTPUT_NOTE } = require('./lyrics');
const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const script = { messages: [{ role: 'system', content: "You are the script desk in Kade-AI's Sound Booth. Write XML." }, { role: 'user', content: 'Format my words.' }] };
const lyric = { messages: [{ role: 'system', content: 'LYRIC — SONGWRITER AND CO-WRITER\nWrite songs.' }] };
const persona = { messages: [{ role: 'system', content: 'You write SYSTEM PROMPTS for characters on a chat platform.' }, { role: 'user', content: "CHARACTER BRIEF (from the person building them):\nA mechanic.\nWrite the character's system prompt now." }] };

test('all dedicated writing desks share the craft layer, including shortening and formatting', () => {
  assert.equal(writingDeskFor(script), 'sound-booth');
  assert.equal(writingDeskFor(lyric), 'lyrics');
  assert.equal(writingDeskFor(persona), 'persona');
  assert.equal(writingDeskFor({ messages: [{ role: 'system', content: 'You are Cole, a 31-year-old songwriter from Nashville by way of Minneapolis, a working co-writer.' }] }), 'lyrics');
  assert.equal(writingDeskFor({ messages: [{ role: 'developer', content: [{ type: 'text', text: script.messages[0].content }] }] }), 'sound-booth');
  for (const body of [{}, { messages: [{ role: 'user', content: script.messages[0].content }] }, { messages: [{ role: 'system', content: 'Quoted: ' + script.messages[0].content }] }]) assert.equal(writingDeskFor(body), '');
});

test('real prompt assembly adds one shared writing note without chat directions or mutation', () => {
  const context = { writingDeskFor, WRITING_STYLE_NOTE, LYRIC_OUTPUT_NOTE, console: { log() {} } };
  vm.runInNewContext(source.slice(source.indexOf('function appendReminder(body)'), source.indexOf('// -- TOOL SHIM')) + '\nthis.run=appendReminder;', context);
  for (const body of [script, lyric, persona]) {
    const original = JSON.stringify(body);
    const result = context.run(body);
    assert.equal(JSON.stringify(body), original);
    assert.equal(result.messages.length, body.messages.length + 1);
    assert.ok(result.messages.at(-1).content.startsWith(WRITING_STYLE_NOTE));
    assert.equal(writingDeskFor(result), writingDeskFor(body), 'return path still recognizes the prepared request');
    assert.equal(result.model, body.model, 'craft does not silently override a selected model');
  }
});

test('real return path leaves lyrics, quoted tells, XML and persona examples byte-identical', async () => {
  const start = source.indexOf('async function detectAndRewrite(');
  const end = source.indexOf('\n// -- fake single-shot SSE', start);
  const context = { writingDeskFor, console: { log() {} }, scrubSearchArtifacts() { throw Error('must not scrub artifact'); } };
  vm.runInNewContext(source.slice(start, end) + '\nthis.run=detectAndRewrite;', context);
  const artifacts = ['[Chorus]\nAt the end of the day\nAt the end of the day', '<speak voice="plain">Great question! I love that.</speak>', '{"instructions":"Never say \\"I hope this helps\\"."}'];
  for (const body of [script, lyric, persona]) for (const content of artifacts) {
    const result = { choices: [{ message: { content } }] };
    assert.equal(await context.run(result, body), result);
    assert.equal(result.choices[0].message.content, content);
  }
});

test('shared craft distinguishes deliberate art and supplied words from filler', () => {
  for (const phrase of ['preserve the supplied words', 'Intentional refrains', 'rhyme and meter', 'never copy this guidance', 'genre, speaker, audience', 'silently check']) assert.ok(WRITING_STYLE_NOTE.includes(phrase));
});
