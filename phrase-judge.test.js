'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {judgeTargets,verifyEdits}=require('./phrase-judge');
const {repairPhrases,detectStockPhrasing,buildTargets,applyEdits}=require('./phrase-repair');

test('Jev asks once for all targets and accepts only bounded numeric probabilities',async()=>{
 let calls=0;
 const state={user:'Why?',draft:'some text',targets:[{id:0,text:'first'},{id:2,text:'second'},{id:3,text:'third'}]};
 const r=await judgeTargets(state,async(s,questions,timeout)=>{
  calls++;assert.equal(s,state);assert.equal(timeout,1200);assert.deepEqual(Object.keys(questions),['target_0','target_2','target_3']);
  assert.match(questions.target_0.criteria.false,/literal reference/);assert.match(questions.target_0.criteria.false,/Dialect/);
  return {answers:{target_0:{noul:.12},target_2:{noul:NaN},target_3:{noul:1.4}},usage:{input_tokens:50},model:'jev-test'};
 });
 assert.equal(calls,1);assert.deepEqual(r.probabilities,{0:.12});assert.equal(r.model,'jev-test');
});

test('a confident ordinary-use decision spends no writing call',async()=>{
 const text='I love the part where the sandwich falls. That dog is quick.';
 const r=await repairPhrases(text,detectStockPhrasing(text),{
  judge:async()=>({probabilities:{0:.15}}),complete:()=>assert.fail('unnecessary rewrite'),
 });
 assert.equal(r.status,'jev_kept');assert.equal(r.text,text);
});

test('Jev can only remove targets; the writer cannot edit a spared passage',async()=>{
 const text='I love the part where the dog sneezes. Funny dog. That matters because you kept a copy.';
 const r=await repairPhrases(text,detectStockPhrasing(text),{
  judge:async()=>({probabilities:{0:.1,1:.7}}),complete:async body=>{
   const input=JSON.parse(body.messages[1].content);assert.deepEqual(input.targets.map(t=>t.id),[1]);
   return {choices:[{message:{content:JSON.stringify({edits:[{id:0,before:'the part ',after:''}]})}}]};
  },
 });
 assert.equal(r.status,'invalid_edit');assert.equal(r.text,text);
});

test('uncertain, missing, malformed or failed Jev opinions leave the bounded writer available',async()=>{
 const text='That matters because you can restore the file. Keep the original too.';
 for(const judge of [async()=>({probabilities:{0:.4}}),async()=>({}),async()=>({probabilities:{0:-.2}}),async()=>({probabilities:{0:'0.1'}}),async()=>{throw Error('offline');}]){
  let calls=0;
  const r=await repairPhrases(text,detectStockPhrasing(text),{judge,complete:async()=>{calls++;return {choices:[{message:{content:'{"edits":[]}'}}]};}});
  assert.equal(calls,1);assert.equal(r.text,text);assert.equal(r.status,'kept');
 }
});

test('protected-only text invokes neither model',async()=>{
 const nope=()=>assert.fail('no call');
 const r=await repairPhrases('"The part that hurts."',[{span:[1,10]}],{judge:nope,complete:nope});
 assert.equal(r.status,'no_targets');
});

test('adjacent flagged sentences share a bounded passage but an unaffected sentence splits it',()=>{
 const text="That matters because I care. The part that worries me is the backup. Nice cup of tea. The part that fits is small.";
 const targets=buildTargets(text,detectStockPhrasing(text));assert.equal(targets.length,2);
 assert.equal(targets[0].text,'That matters because I care. The part that worries me is the backup.');
 assert.equal(targets[1].text,'The part that fits is small.');
});

test('string IDs and sentence-sized proposals shrink to their actual difference',()=>{
 const text='%%%warm%%% That matters because you can restore the file. Keep the original too.';
 const targets=buildTargets(text,detectStockPhrasing(text));
 const r=applyEdits(text,targets,JSON.stringify({edits:[{id:'0',before:targets[0].text,after:'You can restore the file.'}]}));
 assert.equal(r.status,'edited');assert.equal(r.text,'%%%warm%%% You can restore the file. Keep the original too.');
 assert.ok(r.edits[0].before.length < targets[0].text.length);
});

test('meaning review uses one batch and rejects invalid or missing probabilities',async()=>{
 const state={user:'Hi',changes:[{id:0,before:'a',after:'b'},{id:3,before:'c',after:'d'}]};
 let calls=0;
 const r=await verifyEdits(state,async(s,q,timeout)=>{
  calls++;assert.equal(s,state);assert.equal(timeout,1200);assert.deepEqual(Object.keys(q),['change_0','change_3']);
  assert.match(q.change_0.criteria.true,/personal feeling/);
  return {answers:{change_0:{noul:.1},change_3:{noul:.93}},usage:{input_tokens:100},model:'jev-test'};
 });
 assert.equal(calls,1);assert.deepEqual(r.probabilities,{0:.1,3:.93});
 await assert.rejects(verifyEdits(state,async()=>({answers:{change_0:{noul:0}}})),/bad edit review/);
});

test('a meaning veto or unavailable review preserves the original and its separate utility receipt',async()=>{
 const text="The part that stays with me is that you kept his voice. I'd save that recording too.";
 const matches=detectStockPhrasing(text);
 const complete=async()=>({choices:[{message:{content:JSON.stringify({edits:[{id:0,before:'The part that stays with me is that you kept his voice.',after:'You kept his voice.'}]})}}],usage:{prompt_tokens:100}});
 for(const verify of [async input=>{
  assert.equal(input.changes[0].before,'The part that stays with me is that you kept his voice.');
  assert.equal(input.changes[0].after,'You kept his voice.');
  return {probabilities:{0:.93},text:'Jev cannot replace the reply'};
 },async()=>({probabilities:{0:NaN}}),async()=>{throw Error('offline');}]){
  const r=await repairPhrases(text,matches,{complete,verify});
  assert.equal(r.text,text);assert.equal(r.edits.length,0);assert.equal(r.usage.prompt_tokens,100);
  assert.ok(['meaning_rejected','review_failed'].includes(r.status));
 }
});

test('faithful edits pass and unchanged or invalid proposals invoke no meaning review',async()=>{
 const text='That matters because you can restore the file. Keep the original too.';
 const complete=async()=>({choices:[{message:{content:'{"edits":[{"id":0,"before":"That matters because you","after":"You"}]}'}}]});
 const r=await repairPhrases(text,detectStockPhrasing(text),{complete,verify:async()=>({probabilities:{0:.5}})});
 assert.equal(r.text,'You can restore the file. Keep the original too.');
 for(const raw of ['{"edits":[]}','not JSON']){
  await repairPhrases(text,detectStockPhrasing(text),{complete:async()=>({choices:[{message:{content:raw}}]}),verify:()=>assert.fail('unnecessary review')});
 }
});
