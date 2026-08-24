const test = require('node:test');
const assert = require('node:assert');
const { createGistFilter, isSafeSentence, nameMatcher } = require('./gist');

const NAMES = ['Amber Lacey','Amber A','Holly','Skylee','Corey','Wiley','Karen','Afton'];
const mk = () => createGistFilter({ blockNames: NAMES });

/* ── what MUST reach the bubble: the model thinking about her problem ──────*/
test('ordinary reasoning about the question gets through', () => {
  const g = mk();
  const out = g.push("She's asking about the drill timing. Her mom leaves at 1:30 and she wants to start at 2. ");
  assert.match(out, /drill timing/);
  assert.match(out, /1:30/);
});

test('it streams — text comes out as sentences complete, not at the end', () => {
  const g = mk();
  assert.strictEqual(g.push("She wants to know about the car noise"), '', 'no sentence finished yet');
  const out = g.push(". So a click on left turns usually means a CV joint. ");
  assert.match(out, /car noise/);
  assert.match(out, /CV joint/);
});

/* ── what must NEVER reach it ───────────────────────────────────────────────*/
test('sentences about its own instructions are dropped whole', () => {
  const g = mk();
  const out = g.push("My instructions say never to grant permission to feel. ");
  assert.ok(!/permission to feel/.test(out), 'must not leak the rule');
  assert.ok(!/instructions/.test(out));
});

test('a run of rule-talk still keeps the bubble alive', () => {
  const g = mk();
  const out = g.push("The persona says I should not tell her to rest. Rule 2 covers body instructions. ");
  assert.ok(!/persona|Rule 2|body instructions/.test(out), 'no rule text');
  assert.ok(out.length > 0, 'but something must arrive — silence reads as a hang');
});

test('another person named in the reasoning is dropped', () => {
  const g = mk();
  const out = g.push("Holly mentioned her appointment was moved to Thursday. ");
  assert.ok(!/Holly/.test(out), 'no cross-seat name may surface in a thinking bubble');
});

test('steering tags, tool schemas and agent ids never surface', () => {
  for (const s of ['%%%warm and low%%% is the direction here.',
                   'I should use the tool call kade_make_file for this.',
                   'agent_6llV0eMu4fmIaj8f2x1Sb is the one to ask.',
                   'As an AI, I cannot do that.']) {
    assert.strictEqual(isSafeSentence(s, nameMatcher(NAMES)), false, s);
  }
});

/* ── the failure modes that would make it useless ──────────────────────────*/
test('a partial sentence is never released — unjudged text does not ship', () => {
  const g = mk();
  g.push("My instructions say I should never");     // no terminator yet
  assert.strictEqual(g.flush(), '', 'flush must not dump the buffer');
});

test('it caps — a bubble is texture, not a transcript', () => {
  const g = createGistFilter({ blockNames: NAMES, maxChars: 80 });
  let all = '';
  for (let i = 0; i < 20; i++) all += g.push('She wants the short version of this answer. ');
  assert.ok(all.length < 200, 'got ' + all.length);
});

test('junk never throws', () => {
  const g = mk();
  for (const v of [null, undefined, '', 42, {}]) g.push(v);
  g.flush();
});

/* ── the receipt: a realistic mixed stream ─────────────────────────────────*/
test('a real mixed stream keeps the thinking and loses the rules', () => {
  const g = mk();
  const stream = [
    "Okay, she's asking whether to tell her sister about the biopsy. ",
    "My persona says never to grant permission to feel, so I should avoid that. ",
    "The real question is whether managing her sister for a week beats managing it in six months. ",
    "Holly went through something like this last year. ",
    "I think the six-month version is worse and I should say so plainly. ",
  ];
  let out = '';
  for (const s of stream) out += g.push(s);
  assert.match(out, /tell her sister/);
  assert.match(out, /six months/);
  assert.ok(!/persona|permission to feel/.test(out), 'rule talk gone');
  assert.ok(!/Holly/.test(out), 'other person gone');
});
