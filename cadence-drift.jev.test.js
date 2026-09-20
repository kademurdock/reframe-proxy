'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {driftSteerNote,steerRequest,steerOpinions}=require('./cadence-drift');
const convo=(...pairs)=>({messages:[{role:'system',content:'Character'},...pairs.flatMap(([u,a])=>a===undefined?[{role:'user',content:u}]:[{role:'user',content:u},{role:'assistant',content:a}])]});
const neutral=['There are a few ways to look at it, and both have merit.','It depends on what matters most to you in the end.','That is a big decision with a lot of moving parts.'];
const body=last=>convo(['my back hurts',neutral[0]],['the couch is heavy',neutral[1]],['the dog is loud',neutral[2]],[last]);

test('no opinions: the note is exactly what the regexes write',()=>{
 const b=body('would it be dumb to drive to Little Rock in this weather');
 assert.equal(driftSteerNote(b,{}),driftSteerNote(b,{opinions:undefined}));
 assert.doesNotMatch(driftSteerNote(b,{}),/asked what you actually think/);
});
test('Jev hears an indirect ask the trigger words miss',()=>{
 const note=driftSteerNote(body('would it be dumb to drive to Little Rock in this weather'),{opinions:{asksTake:0.95,tookTake:0.05}});
 assert.match(note,/asked what you actually think/);
});
test('an unsure Jev does not add the note, and a staked claim heard by Jev removes it',()=>{
 assert.doesNotMatch(driftSteerNote(body('would it be dumb to drive there'),{opinions:{asksTake:0.7,tookTake:0.05}}),/actually think/);
 const asked=body('what do you think I should do');
 assert.match(driftSteerNote(asked,{}),/actually think/);
 assert.doesNotMatch(driftSteerNote(asked,{opinions:{asksTake:0.9,tookTake:0.9}}),/actually think/);
});
test('a confident Jev yes raises the repetition note that word overlap missed, and logs through onEcho',()=>{
 const seen=[];
 const note=driftSteerNote(body('anyway it might snow'),{opinions:{echo:0.96},onEcho:e=>seen.push(e)});
 assert.match(note,/Repetition note/);assert.equal(seen[0].jev,0.96);
 assert.doesNotMatch(driftSteerNote(body('anyway it might snow'),{opinions:{echo:0.6}}),/Repetition note/);
});
test('the request carries the person and recent replies, tags stripped, and skips echo on a requested recap',()=>{
 const b=convo(['my back hurts','%%%warm%%% Heat, then walking.'],['ok','Good.'],['did you see the snow']);
 const r=steerRequest(b,{});
 assert.equal(r.state.message,'did you see the snow');
 assert.deepEqual(r.state.recentReplies,['Heat, then walking.','Good.']);
 assert.ok(r.questions.echo&&r.questions.asksTake&&r.questions.tookTake);
 assert.equal(steerRequest(convo(['a','b'],['c','d'],['please repeat that']),{}).questions.echo,undefined);
 assert.equal(steerRequest(convo(['a','b'],['c']),{}),null);
});
test('malformed answers are dropped',()=>{
 assert.deepEqual(steerOpinions({asksTake:{noul:0.9},tookTake:{noul:'x'},echo:null,other:{noul:1}}),{asksTake:0.9});
 assert.deepEqual(steerOpinions(undefined),{});
});
