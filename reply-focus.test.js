'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {reviewInput,verdict,repairRepetition}=require('./reply-focus');
const body={model:'x-ai/grok-4.20',messages:[
 {role:'system',content:'Character identity and privacy rules'},
 {role:'user',content:'Where did the fictional painter study?'},
 {role:'assistant',content:'At Redfern. What do you like in her work? %%%reset%%%'},
 {role:'user',content:'# Runtime\nold school records'},
 {role:'user',content:'The violet light.'},
 {role:'assistant',content:'Looking.',tool_calls:[{id:'x'}]},
 {role:'tool',tool_call_id:'x',content:'A gallery entry'},
]};
const options={isInjected:t=>t.startsWith('# Runtime')};
const answer=(content,finish_reason='stop')=>({choices:[{message:{content},finish_reason}],usage:{prompt_tokens:20,completion_tokens:10,cost:0.001}});
const yes=JSON.stringify({replay:true,confidence:'high',reason:'Repeats the school instead of discussing color.',focus:'The violet light.'});
const no=JSON.stringify({replay:false,confidence:'high',reason:'New response.',focus:'The violet light.'});
test('reads only completed dialogue and keeps tool traffic out of the reviewer input',()=>{
 const input=reviewInput(body,'She studied at Redfern.',options);
 assert.equal(input.latestUser,'The violet light.');
 assert.equal(input.history.length,1);
 assert.doesNotMatch(JSON.stringify(input),/old school records|Looking|gallery entry/);
});
test('explicit repeat requests skip all paid calls',async()=>{
 for(const content of ['Please repeat where she studied.','Actually, please repeat where she studied.','Could you repeat the name?']) {
  const repeated={...body,messages:[...body.messages.slice(0,3),{role:'user',content}]};
  const out=await repairRepetition(repeated,'Redfern.',{...options,complete:()=>{throw Error('Must not call');}});
  assert.equal(out.status,'skipped');assert.equal(out.events.length,0);
 }
});
test('first turn and oversized latest input skip without guessing at truncated data',()=>{
 assert.equal(reviewInput({messages:[{role:'user',content:'Hi'}]},'Hi'),null);
 assert.equal(reviewInput({messages:[...body.messages.slice(0,3),{role:'user',content:'a'.repeat(6001)}]},'Reply'),null);
});
test('malformed and uncertain verdicts cannot trigger regeneration',()=>{
 for(const s of ['hello','{}','{"replay":"true"}'])assert.equal(verdict(s),null);
 assert.equal(verdict(JSON.stringify({replay:true,confidence:'uncertain',reason:'Maybe',focus:'Color'})).replay,false);
});
test('accepted original stays byte identical and only pays one review',async()=>{
 const draft='%%%laugh%%% That violet has some nerve.';
 const result=await repairRepetition(body,draft,{...options,complete:async()=>answer(no)});
 assert.equal(result.text,draft);assert.equal(result.status,'kept');assert.equal(result.events.length,1);
});
test('replaces on the original model only after independent verification, without mutating history',async()=>{
 const before=JSON.stringify(body), calls=[];
 const results=[answer(yes),answer('%%%laugh%%% That violet has some nerve.'),answer(no)];
 const result=await repairRepetition(body,'She studied at Redfern.',{...options,complete:async(request,timeout)=>{calls.push({request,timeout});return results.shift();}});
 assert.equal(result.status,'repaired');assert.equal(result.events.length,3);
 assert.equal(calls[1].request.model,body.model);assert.equal(calls[1].request.tools,undefined);
 assert.equal(calls[1].request.messages[0].content,body.messages[0].content);
 assert.equal(JSON.stringify(body),before);assert.match(result.text,/%%%laugh%%%/);
 assert.ok(calls.every(c=>c.timeout<=14000));
});
test('unavailable, empty, truncated, or still-repetitive repair never replaces the original',async()=>{
 for(const results of [[answer(yes),answer('','stop')],[answer(yes),answer('cut','length')],[answer(yes),answer('Still repeats'),answer(yes)],[answer(yes),answer('New'),answer('broken')]]){
  const result=await repairRepetition(body,'Original',{...options,complete:async()=>results.shift()});
  assert.equal(result.text,'Original');assert.ok(result.events.length<=3);
 }
 const unavailable=await repairRepetition(body,'Original',{...options,complete:async()=>{throw Error('timeout');}});
 assert.equal(unavailable.status,'unavailable');assert.equal(unavailable.events.length,1);
});
