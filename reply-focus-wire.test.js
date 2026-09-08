const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
test('HTTP streaming and buffered replies review the final draft and deliver the verified character repair',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'focus-wire-')),receipt=path.join(dir,'requests.jsonl');fs.writeFileSync(receipt,'');
 const child=spawn(process.execPath,['--require',path.join(__dirname,'test-fixtures/reply-focus.cjs'),'server.js'],{cwd:__dirname,env:{...process.env,PORT:'31862',OPENROUTER_KEY:'offline',PROXY_SHARED_SECRET:'offline',ZAI_KEY:'',KADE_BRIDGE_URL:'',MODEL_WIRE_RECEIPT:receipt},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 try{
  let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch('http://127.0.0.1:31862/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,50));}assert.ok(ready,log);
  for(const stream of [false,true]){
   const before=fs.readFileSync(receipt,'utf8').trim().split('\n').filter(Boolean).length;
   const r=await fetch('http://127.0.0.1:31862/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer offline'},body:JSON.stringify({model:'x-ai/grok-4.20',stream,max_tokens:300,messages:[
    {role:'system',content:'You are Kiana, flagship intelligence of Kade-AI.'},
    {role:'user',content:'Why use heavy paper?'},{role:'assistant',content:'It resists ink showing through. Try a sketchbook.'},
    {role:'user',content:'- Note: Semantic search is available through the file_search tool but no files are currently loaded. injected inventory'},
    {role:'user',content:'The corner shop is easier. [INSTANT]'},
    {role:'assistant',content:'',tool_calls:[{id:'lookup',type:'function',function:{name:'memory',arguments:'{}'}}]},
    {role:'tool',tool_call_id:'lookup',content:'injected inventory'},
   ]})});
   assert.equal(r.status,200,log);const raw=await r.text();
   const text=stream?raw.split('\n').filter(l=>l.startsWith('data: {')).map(l=>JSON.parse(l.slice(6)).choices?.[0]?.delta?.content||'').join(''):JSON.parse(raw).choices[0].message.content;
   assert.equal(text,'%%%amused%%% Then the corner shop wins. I sent you shopping when the notebook was already right there.',log);
   const calls=fs.readFileSync(receipt,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).slice(before);
   const reviews=calls.filter(b=>b.messages[0].content.startsWith('Check whether'));
   assert.equal(reviews.length,2,log);assert.equal(JSON.parse(reviews[0].messages[1].content).draft,'Heavy paper resists ink showing through.');
   assert.equal(JSON.parse(reviews[1].messages[1].content).draft,text);
   assert.equal(calls.at(-1),reviews[1]);
  }
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
