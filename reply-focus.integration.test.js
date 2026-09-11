const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const start=source.indexOf('async function detectAndRewrite('),end=source.indexOf('\n// -- fake single-shot SSE',start);
function setup(enabled=true){
 const calls=[];
 const context={console, REPLY_FOCUS_ON:enabled, replyFocusCounts:{}, COHERENCE_ON:false,
  scrubSearchArtifacts:t=>t,normalizeVoiceTagTypos:t=>t,isLyricBody:b=>b.lyric,isSweptMachineBody:b=>b.machine,isMemoryKeeperShapedBody:b=>!!b.keeper,KEEPER_OUT_CARVEOUT:true,
  isKianaBody:b=>b.kiana,looksInjected:()=>false,stripContextReplay:t=>t,coherenceTells:()=>[],
  callOpenRouterOnce:()=>{throw Error('Must be passed to the guarded helper, not called directly');},
  repairRepetition:async(body,draft,options)=>{calls.push({body,draft,options});return {text:'Fresh character reply',status:'repaired',events:[{model:'utility',usage:{prompt_tokens:99}}]};},
  collectMatches:()=>[],
 };
 vm.runInNewContext(source.slice(start,end)+'\nthis.run=detectAndRewrite;',context);
 return {context,calls};
}
test('delivery uses verified replacement but never bills utility tokens at character-model rates',async()=>{
 const {context,calls}=setup();const usage={prompt_tokens:10,completion_tokens:12,cost:0.002};
 const result={choices:[{message:{content:'Old reply'}}],usage};
 await context.run(result,{kiana:true});
 assert.equal(result.choices[0].message.content,'Fresh character reply');
 assert.equal(result.usage,usage);assert.equal(calls.length,1);
 assert.equal(context.replyFocusCounts.repaired,1);
});
test('other characters, machinery, lyrics, JSON and disabled mode do not enter the paid guard',async()=>{
 for(const body of [{kiana:false},{kiana:true,machine:true},{kiana:true,lyric:true}]){
  const {context,calls}=setup();await context.run({choices:[{message:{content:'Original'}}]},body);assert.equal(calls.length,0);
 }
 for(const [enabled,content] of [[false,'Original'],[true,'{"data":1}'],[true,'']]){
  const {context,calls}=setup(enabled);await context.run({choices:[{message:{content}}]},{kiana:true});assert.equal(calls.length,0);
 }
});
