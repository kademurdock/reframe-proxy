'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), os=require('node:os'), path=require('node:path'), {spawn}=require('node:child_process');

test('production return path: local edits, contextual keeps, streaming, failures, exclusions and rollback',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'phrase-wire-')),receipt=path.join(dir,'requests.jsonl');
 async function run({draft,patch,body={},env={}}){
  fs.writeFileSync(receipt,'');
  const child=spawn(process.execPath,['--require',path.join(__dirname,'test-fixtures/model.cjs'),'server.js'],{cwd:__dirname,env:{...process.env,PORT:'31874',OPENROUTER_KEY:'offline',PROXY_SHARED_SECRET:'offline',ZAI_KEY:'',KADE_REPLY_FOCUS:'0',MODEL_WIRE_RECEIPT:receipt,MODEL_WIRE_ORIGINAL:draft,MODEL_WIRE_PATCH:JSON.stringify(patch),...env},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
  try{
   let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch('http://127.0.0.1:31874/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,50));}assert.ok(ready,log);
   const r=await fetch('http://127.0.0.1:31874/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer offline'},body:JSON.stringify({model:'x-ai/grok-4.20',stream:false,max_tokens:300,messages:[{role:'system',content:'Talk to your friend.'},{role:'user',content:'What do you think? [INSTANT]'}],...body})});
   assert.equal(r.status,200,await r.clone().text());
   const raw=await r.text();
   const result=body.stream?raw.split('\n').filter(x=>x.startsWith('data: {')).map(x=>JSON.parse(x.slice(6))).find(x=>x.choices[0].delta.content)?.choices[0].delta.content:JSON.parse(raw).choices[0].message.content;
   const calls=fs.readFileSync(receipt,'utf8').trim().split('\n').map(JSON.parse);
   return {result,calls:calls.filter(b=>b.messages[0].content.startsWith('You edit small')),log,raw};
  }finally{child.kill();await new Promise(r=>child.once('exit',r));}
 }
 const draft="%%%warm%%% That matters because you can restore the copy. Damn, I like that feature.\n\n%%%amused%%% I'd keep it.";
 const patch={edits:[{id:0,before:'That matters because you',after:'You'}]};
 for(const stream of [false,true]){
  const r=await run({draft,patch,body:{stream}});
  assert.equal(r.result,draft.replace(patch.edits[0].before,'You'));assert.equal(r.calls.length,1);assert.match(r.log,/phrase-repair.*edited/);
  assert.doesNotMatch(r.log,/running rewrite pass|one more swing/);
  if(!stream)assert.equal(JSON.parse(r.raw).usage.prompt_tokens,10,'utility tokens not billed at the character model rate');
 }
 const ordinary='%%%amused%%% I love the part where the dog steals his sandwich. Poor guy.';
 const kept=await run({draft:ordinary,patch:{edits:[]}});assert.equal(kept.result,ordinary);assert.equal(kept.calls.length,1);assert.match(kept.log,/phrase-repair.*kept/);
 const bad=await run({draft,patch:{edits:[{id:0,before:draft,after:'New answer.'}]}});assert.equal(bad.result,draft);assert.equal(bad.calls.length,1);
 for(const artifact of ['{"text":"That matters because it works."}','```js\n// That matters because it works.\n```','> The part that matters is quoted.']){
  const r=await run({draft:artifact,patch});assert.equal(r.result,artifact);assert.equal(r.calls.length,0);
 }
 const structured=await run({draft,patch,body:{response_format:{type:'json_object'}}});
 assert.equal(structured.result,draft);assert.equal(structured.calls.length,0);
 const off=await run({draft,patch,env:{KADE_PHRASE_REPAIR:'0'}});assert.equal(off.result,draft);assert.equal(off.calls.length,0);
});
