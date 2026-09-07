'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { driftSteerNote, _internals } = require('./cadence-drift');
// Entirely invented. No model calls or personal transcripts.
const advice = 'Keep the blue toolbox on the lower garage shelf so the handle clears the cupboard door.';
const music = 'The new drummer keeps a steady beat and leaves enough space for the bass line.';
const bread = 'The bakery puts fresh rye loaves beside the front counter every morning.';
const u = content => ({role:'user',content});
const a = content => ({role:'assistant',content});
const pair = (user, answer) => [u(user), a(answer)];
const request = (last = 'The bakery has started making excellent rye bread.') => ({messages:[
  ...pair('Where should I store my blue toolbox?', advice),
  ...pair('The new drummer leaves more room for the bass.', music+'\n\n'+advice), u(last),
]});
const note = body => /Repetition note:/.test(driftSteerNote(body));

test('one unrelated old paragraph is noticed without echoing its topic in the note', () => {
  const body = request();
  const before = JSON.stringify(body);
  assert.equal(note(body), true);
  assert.doesNotMatch(driftSteerNote(body), /toolbox|garage|cupboard/);
  assert.equal(JSON.stringify(body), before, 'request must remain intact');
});
test('a distant old paragraph remains visible beyond three replies', () => {
  const body = request();
  body.messages.splice(2,0,...pair('That rye bread was delicious.',bread),
    ...pair('The bass player was excellent.',music),...pair('The bread has a crisp crust.',bread));
  assert.equal(note(body),true);
});
test('requested repetition in the historical turn is not diagnosed as unsolicited', () => {
  const body=request(); body.messages[2]=u('Please repeat your toolbox advice exactly.');
  assert.equal(note(body),false);
});
test('a full requested recap is exempt even when the old assistant-only detector fires', () => {
  const full=advice+' Put the brass screws in separate labeled jars so you can find the correct size quickly.';
  for (const historical of [true,false]) {
    const body={messages:[...pair('Help organize the garage storage for the weekend.',full),
      ...pair(historical?'Please repeat all your earlier advice exactly for my notes.':'Tell me about the band and the new drummer.',full),
      u(historical?'The bakery has started making excellent rye bread.':'Please repeat all the earlier advice exactly for my notes.')]};
    assert.ok(_internals.contentEcho([full,full]));
    assert.equal(note(body),false);
  }
});
test('current requests for repetition and named follow-ups stay available', () => {
  for(const s of ['Please repeat the advice exactly.', 'Remind me what you said earlier.',
    'Where should the blue toolbox go?', 'What about the cupboard door?',
    'Can you explain that?', 'Why?']) assert.equal(note(request(s)),false,s);
});
test('historical follow-up on the repeated topic is allowed', () => {
  const body=request(); body.messages[2]=u('Would the blue toolbox fit by the cupboard door?');
  assert.equal(note(body),false);
});
test('fresh answers and very short shared phrases are not flagged', () => {
  const body=request(); body.messages[3]=a(music); assert.equal(note(body),false);
  body.messages[1]=a('Good idea.'); body.messages[3]=a('Good idea.'); assert.equal(note(body),false);
});
test('no current human turn means no prospective repetition instruction', () => {
  const body=request(); body.messages.pop(); assert.equal(note(body),false);
});
test('a request to stop repeating is not treated as a repeat request', () => {
  assert.equal(note(request('Stop repeating the old subjects. Tell me about the rye bread.')),true);
});
test('a complaint about repetition is not permission to repeat', () => {
  for(const text of ['You keep repeating old advice whenever I change subjects.',
    'You repeated the same things three times. Tell me a story.',
    'That happened again. The bakery has started making excellent rye bread.']) {
    assert.equal(note(request(text)),true,text);
  }
});
test('tool preambles are not completed answers and tool chains remain intact', () => {
  const body=request(); body.messages.push({role:'assistant',content:advice,tool_calls:[{id:'x'}]},
    {role:'tool',content:advice,tool_call_id:'x'});
  const before=JSON.stringify(body); assert.equal(note(body),true); assert.equal(JSON.stringify(body),before);
  const clean=request(); clean.messages[3]={role:'assistant',content:advice,tool_calls:[{id:'x'}]};
  assert.equal(note(clean),false);
});
test('injected context and content parts use caller-provided person parsing', () => {
  const body=request(); body.messages[4]=u([{type:'text',text:'The bakery has started making excellent rye bread.'}]);
  body.messages.push(u('INTERNAL toolbox garage cupboard'));
  const options={isInjected:text=>text.startsWith('INTERNAL')};
  assert.ok(_internals.conversationEcho(body,options));
});
