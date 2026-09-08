'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {driftSteerNote,detectDrift}=require('./cadence-drift');
const {voiceNoteFor}=require('./voice-anchors');
const s=fs.readFileSync(require.resolve('./server.js'),'utf8');
const ctx={isPhoneTurn:b=>b.phone};
vm.runInNewContext(s.slice(s.indexOf('function laneNoteFor(body)'),s.indexOf('/* ⚠️ TITLE / SUMMARIZER CALLS'))+'\nthis.note=laneNoteFor;',ctx);
test('written lane permits a continuing feeling without mood or tag quotas',()=>{
 const note=ctx.note({});assert.match(note,/natural conversational pace/);
 assert.match(note,/Plain passages can be untagged/);
 assert.doesNotMatch(note,/never open two|DENSITY:|mood plus pace|at least one more|speak slow/);
 assert.equal(ctx.note({phone:true}),'');
});
test('repeated quiet tags retain contextual choice on request and response paths',()=>{
 const body={messages:[1,2,3].flatMap(i=>[{role:'user',content:'We are still talking about the same disappointment '+i}, {role:'assistant',content:'%%%quiet and careful%%% I think that was unfair. The facts still matter.'}])};
 for(const note of [driftSteerNote(body),detectDrift('%%%quiet and careful%%% I disagree with their decision.',body).steer]) {
  assert.match(note,/pace consistent|conversational pace/);
  assert.doesNotMatch(note,/different mood|different pace|somewhere else/);
 }
});
test('Kiana register anchors stay scoped and do not prescribe flat celebration',()=>{
 assert.equal(voiceNoteFor({messages:[{role:'system',content:'You are a different character.'}]}),'');
 const note=voiceNoteFor({messages:[{role:'system',content:'You are the flagship intelligence of Kade-AI.'}]});
 assert.match(note,/diplomatic ear/);assert.doesNotMatch(note,/glad never needs/);
});
