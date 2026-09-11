const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const start=source.indexOf('async function detectAndRewrite('),end=source.indexOf('\n// -- fake single-shot SSE',start);
function setup({long=false,repair=false,coherent=true}={}){
 const seen=[],events=[];
 const context={console,REPLY_FOCUS_ON:true,replyFocusCounts:{},COHERENCE_ON:true,SLOP_REWRITE_MAX_CHARS:long?3:10000,SLOP_VERIFY:true,
  scrubSearchArtifacts:t=>t,normalizeVoiceTagTypos:t=>t,isLyricBody:()=>false,isSweptMachineBody:()=>false,isMemoryKeeperShapedBody:()=>false,KEEPER_OUT_CARVEOUT:true,isKianaBody:()=>true,
  looksInjected:()=>false,stripContextReplay:t=>t,coherenceTells:t=>!coherent&&t==='Character correction'?['bad']:[],
  coherenceRetryWorthy:()=>false,protectSentinelTags:t=>({text:t,tags:[]}),restoreSentinelTags:t=>t,
  collectMatches:t=>['Initial reply','Character correction'].includes(t)?[{pattern:'clean_tic'}]:[],
  rewritePass:async()=>{events.push('polish');return {text:'Polished reply',usage:null};},
  sumUsage:a=>a,slopStats:{record(){},outcome(){}},
  callOpenRouterOnce:()=>{throw Error('unexpected direct call');},
  repairRepetition:async(body,draft)=>{events.push('review');seen.push(draft);return {text:repair?'Character correction':draft,status:repair?'repaired':'kept',events:[]};},
 };
 vm.runInNewContext(source.slice(start,end)+'\nthis.run=detectAndRewrite;',context);
 return {context,seen,events};
}
test('relevance review sees the text that prose cleanup would actually deliver',async()=>{
 const {context,seen,events}=setup();const result={choices:[{message:{content:'Initial reply'}}]};
 await context.run(result,{});
 assert.deepEqual(seen,['Polished reply']);assert.deepEqual(events,['polish','review']);
 assert.equal(result.choices[0].message.content,'Polished reply');
});
test('an approved character repair is not overwritten by a later utility rewrite',async()=>{
 const {context,seen,events}=setup({repair:true});const result={choices:[{message:{content:'Initial reply'}}]};
 await context.run(result,{});assert.equal(result.choices[0].message.content,'Character correction');
 assert.deepEqual(events,['polish','review']);assert.equal(seen.length,1);
});
test('long-form prose bypass still gets the bounded relevance decision',async()=>{
 const {context,seen,events}=setup({long:true});const result={choices:[{message:{content:'Initial reply'}}]};
 await context.run(result,{});assert.deepEqual(seen,['Initial reply']);assert.deepEqual(events,['review']);
});
test('incoherent replacement retains the reviewed polished draft',async()=>{
 const {context}=setup({repair:true,coherent:false});const result={choices:[{message:{content:'Initial reply'}}]};
 await context.run(result,{});assert.equal(result.choices[0].message.content,'Polished reply');
});
