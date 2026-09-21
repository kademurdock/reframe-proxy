'use strict';
process.env.TYPESAFE_API_KEY='test-key';
const test=require('node:test'), assert=require('node:assert/strict');
const {listen,QUESTIONS}=require('./jev-shadow');
const long='That cat knows exactly what it is doing. Nap this afternoon, and tonight shut the blinds on that side of the house.';

test('listens once, strips voice tags, reports what the detectors said, and returns rounded readings',async()=>{
 const seen=[];
 const ask=async(state,questions,timeout)=>{seen.push({state,questions,timeout});return {answers:{userEcho:{noul:0.123},uninvitedReassurance:{noul:0.9},pastedVoice:{noul:'x'}}};};
 const p=await listen('%%%dry%%% '+long,'the dog kept me up',[{pattern:'user_echo'},{pattern:'user_echo'}],'abc',ask);
 assert.deepEqual(p,{userEcho:0.12,uninvitedReassurance:0.9});
 assert.equal(seen.length,1);assert.doesNotMatch(seen[0].state.reply,/%%%/);assert.equal(seen[0].questions,QUESTIONS);
});
test('short replies, missing person text, and the kill switch ask nothing',async()=>{
 const ask=async()=>{throw Error('Must not call');};
 assert.equal(listen('Seven.','how many days',[], 'r',ask),null);
 assert.equal(listen(long,'',[], 'r',ask),null);
 process.env.KADE_JEV_SHADOW='0';
 assert.equal(listen(long,'hello there',[], 'r',ask),null);
 delete process.env.KADE_JEV_SHADOW;
});
test('a failing Jev resolves to null and nothing escapes',async()=>{
 assert.equal(await listen(long,'hello there',[], 'r',async()=>{throw Error('HTTP 503');}),null);
});

test('essay voice joins the existing request, and invalid probabilities are ignored',async()=>{
 let calls=0;
 const p=await listen(long,'Just talking, not requesting a poem',[],'essay',async(state,questions)=>{
  calls++;
  assert.equal(questions.essayVoice.type,'noul');
  assert.match(questions.essayVoice.criteria.false,/explicitly requested/);
  return {answers:{essayVoice:{noul:0.876},userEcho:{noul:Infinity},pastedVoice:{noul:-0.1}}};
 });
 assert.equal(calls,1);
 assert.deepEqual(p,{essayVoice:0.88});
});
