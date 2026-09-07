'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
// Execute the actual routing functions without starting the HTTP server or a model.
const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const textStart = source.indexOf('function messageTextOf(content)');
const textEnd = source.indexOf('\n// NOTE 2', textStart);
const pickStart = source.indexOf('const DYNAMIC_TAIL_MARKERS =');
const pickEnd = source.indexOf('\nfunction autoThinkExcerpt', pickStart);
assert.ok(textStart >= 0 && textEnd > textStart && pickStart >= 0 && pickEnd > pickStart);
const sandbox = {};
vm.runInNewContext(source.slice(textStart, textEnd) + '\n' + source.slice(pickStart, pickEnd) + '\nthis.pick = autoThinkPersonPick;', sandbox);
const body = (...messages) => ({messages: [{role:'system',content:'Persona'}, ...messages]});
const user = content => ({role:'user',content});
const person = 'He just sent a photo of a ridiculous purple wizard hat. That made me laugh.';
const emptyFiles = '- Note: Semantic search is available through the file_search tool but no files are currently loaded. Request the user to upload documents to search through.';
const loadedFiles = '- Note: Use the file_search tool to find relevant information within:\n\t- schedule.txt';
for (const [name, note] of [['no files',emptyFiles],['attached files',loadedFiles]]) {
  test(`file-search context before person: ${name}`, () => {
    const result = sandbox.pick(body(user(note+'\n\n# Logbook recall\nAn invented old note.'), user(person)));
    assert.equal(result.text, person);
    assert.equal(result.skipped, 1);
  });
  test(`file-search context after person: ${name}`, () => {
    assert.equal(sandbox.pick(body(user(person),user(note))).text, person);
  });
}
test('typed content parts and subsequent tool traffic retain the human message', () => {
  const result=sandbox.pick(body(user([{type:'text',text:emptyFiles}]),user([{type:'text',text:person}]),
    {role:'assistant',content:null,tool_calls:[{id:'t1',function:{name:'example'}}]},
    {role:'tool',content:'Result',tool_call_id:'t1'}));
  assert.equal(result.text, person);
});
test('ordinary markdown and a user note about searching are not machinery', () => {
  for (const text of ['# My question\nCan you explain this?', '- Note: I use file_search at work. What does semantic search mean?', 'Semantic search is available in my editor.']) {
    assert.equal(sandbox.pick(body(user(text),user(emptyFiles))).text,text);
  }
});
test('existing runtime marker still skips correctly', () => {
  assert.equal(sandbox.pick(body(user('# `web_search` Runtime Context\nNo searches yet.'),user(person))).text,person);
});
test('injected-only input preserves the existing nonempty fallback', () => {
  assert.equal(sandbox.pick(body(user(emptyFiles))).text,emptyFiles);
});
