'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {repairRepetition}=require('./reply-focus');
const body={model:'deepseek/deepseek-v4.1-flash',messages:[
 {role:'system',content:'Character identity'},
 {role:'user',content:'Where did the fictional painter study?'},
 {role:'assistant',content:'At Redfern. What do you like in her work?'},
 {role:'user',content:'The violet light.'},
]};
const answer=content=>({choices:[{message:{content},finish_reason:'stop'}],usage:{prompt_tokens:20}});
const yes=JSON.stringify({replay:true,confidence:'high',reason:'Repeats the school.',focus:'The violet light.'});
const no=JSON.stringify({replay:false,confidence:'high',reason:'New response.',focus:'The violet light.'});
const judgeOf=(...ps)=>{const seen=[];const judge=async input=>{seen.push(input);const p=ps.shift();if(p instanceof Error)throw p;return {p,usage:{input_tokens:300},model:'jev-1.13.0'};};judge.seen=seen;return judge;};

test('a clear Jev verdict keeps the draft and the slow review never runs',async()=>{
 const judge=judgeOf(0.04);
 const out=await repairRepetition(body,'That violet is doing all the work.',{judge,complete:()=>{throw Error('Must not call');}});
 assert.equal(out.status,'kept');assert.equal(out.text,'That violet is doing all the work.');
 assert.equal(out.events.length,1);assert.equal(out.events[0].p,0.04);
 assert.equal(judge.seen[0].latestUser,'The violet light.');
});
test('Jev alone can never cause a repair: the glm review has to agree',async()=>{
 const calls=[];
 const out=await repairRepetition(body,'She studied at Redfern.',{judge:judgeOf(0.97),complete:async r=>{calls.push(r);return answer(no);}});
 assert.equal(out.status,'kept');assert.equal(out.text,'She studied at Redfern.');assert.equal(calls.length,1);
});
test('both agree, Jev clears the repair: repaired with one glm review and no glm recheck',async()=>{
 const replies=[yes,'The violet is what makes it ache.'];const calls=[];
 const out=await repairRepetition(body,'She studied at Redfern.',{judge:judgeOf(0.97,0.06),complete:async r=>{calls.push(r);return answer(replies.shift());}});
 assert.equal(out.status,'repaired');assert.equal(out.text,'The violet is what makes it ache.');assert.equal(calls.length,2);
});
test('Jev calls the repair a replay too: the person gets the original draft',async()=>{
 const replies=[yes,'She studied at Redfern, as I said.'];
 const out=await repairRepetition(body,'She studied at Redfern.',{judge:judgeOf(0.97,0.91),complete:async()=>answer(replies.shift())});
 assert.equal(out.status,'repair_rejected');assert.equal(out.text,'She studied at Redfern.');assert.match(out.review.recheck,/jev p=0\.91/);
});
test('a failing Jev leaves the old road exactly as it was',async()=>{
 const replies=[yes,'The violet is what makes it ache.',no];const calls=[];
 const out=await repairRepetition(body,'She studied at Redfern.',{judge:judgeOf(Error('timeout 2500ms'),Error('HTTP 503')),complete:async r=>{calls.push(r);return answer(replies.shift());}});
 assert.equal(out.status,'repaired');assert.equal(calls.length,3);
 assert.equal(out.events.filter(e=>e.error).length,2);
});
