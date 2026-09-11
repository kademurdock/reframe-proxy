/* Part 179 (Sep 11 2026): the rewriter is handed the WHOLE scripted example a
 * parrot run came from, and told to drop the bit rather than swap its nouns.
 * Receipt for why: the 11:30Z Sep 11 vischeck probe tripped persona_parrot on
 * the Dolly/Whitney example and the rewrite shipped "car or the highway" for
 * "engine or the road" -- same skeleton, same punchline, guard satisfied. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { detectPersonaParrot, detectEchoGuard } = require('./echo-guard');

const EXAMPLE = "Whitney's the voice. Dolly's the writer. That's like asking whether the engine or the road is better. One record for a desert island, it's Jolene.";
const SYS = 'Them: Dolly or Whitney?\nYou: ' + EXAMPLE + '\n\nThem: something else\nYou: a different line entirely about air fryers and airlines\n';

test('a parrot match carries the whole example line it was lifted from', () => {
  const m = detectPersonaParrot("Honestly that's like asking whether the engine or the road is better, and I mean it.", SYS);
  assert.equal(m.length, 1);
  assert.match(m[0].detail, /engine or the road/);
  assert.equal(m[0].example, EXAMPLE);
});

test('detectEchoGuard passes the example through the shared entry point', () => {
  const body = { messages: [{ role: 'system', content: SYS }, { role: 'user', content: 'Dolly or Whitney?' }] };
  const m = detectEchoGuard("One record for a desert island, it's Jolene, no contest.", body, { humanText: 'Dolly or Whitney?' });
  assert.equal(m.length, 1);
  assert.equal(m[0].pattern, 'persona_parrot');
  assert.equal(m[0].example, EXAMPLE);
});

function rewritePromptBuilder() {
  const s = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const ctx = {};
  vm.runInNewContext(
    s.slice(s.indexOf('const PATTERN_GUIDANCE ='), s.indexOf('// Aug 10 2026 — HER STUCK TEMP CHAT')) + '\nthis.prompt=buildRewriteSystemPrompt;',
    ctx,
  );
  return ctx.prompt;
}

test('the rewrite prompt quotes the scripted example and forbids the noun swap', () => {
  const prompt = rewritePromptBuilder();
  const match = { pattern: 'persona_parrot', kind: 'rewrite', detail: 'whether the engine or the road is better', example: EXAMPLE };
  const text = prompt([match], false);
  assert.match(text, /from the scripted example: "Whitney's the voice/);
  assert.match(text, /nouns swapped/);
  assert.match(text, /Cut that whole bit/);
  assert.match(text, /same voice/);
});

test('a reply with no parrot in it gets none of the script instruction', () => {
  const prompt = rewritePromptBuilder();
  const text = prompt([{ pattern: 'reframe_bare', kind: 'rewrite' }], false);
  assert.doesNotMatch(text, /Cut that whole bit/);
  assert.doesNotMatch(text, /scripted example/);
  assert.match(text, /Make the smallest edits/);
});

test('a parrot match without an example still names the copied words', () => {
  const prompt = rewritePromptBuilder();
  const text = prompt([{ pattern: 'persona_parrot', kind: 'rewrite', detail: 'small regional airline for chicken' }], false);
  assert.match(text, /"small regional airline for chicken"/);
  assert.doesNotMatch(text, /from the scripted example/);
  assert.match(text, /Cut that whole bit/);
});
