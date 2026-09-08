const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
test('production HTTP reply path detects labels, dispatches a minimal repair and restores speech tags',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rewrite-wire-')),receipt=path.join(dir,'requests.jsonl');fs.writeFileSync(receipt,'');
 const child=spawn(process.execPath,['--require',path.join(__dirname,'test-fixtures/model.cjs'),'server.js'],{cwd:__dirname,env:{...process.env,PORT:'31861',OPENROUTER_KEY:'offline',PROXY_SHARED_SECRET:'offline',ZAI_KEY:'',MODEL_WIRE_RECEIPT:receipt},stdio:['ignore','pipe','pipe']});
 let log='';child.stdout.on('data',x=>log+=x);child.stderr.on('data',x=>log+=x);
 try{
  let ready=false;for(let i=0;i<80;i++){try{ready=(await fetch('http://127.0.0.1:31861/health')).ok;}catch{}if(ready)break;await new Promise(r=>setTimeout(r,50));}assert.ok(ready,log);
  const r=await fetch('http://127.0.0.1:31861/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer offline'},body:JSON.stringify({model:'x-ai/grok-4.20',stream:false,max_tokens:300,messages:[{role:'system',content:'Speak casually with your friend.'},{role:'user',content:'What do you think? [INSTANT]'}]})});
  assert.equal(r.status,200);const out=(await r.json()).choices[0].message.content;
  assert.match(out,/^%%%amused%%%/);assert.match(out,/damn/);assert.match(out,/I'd still go to trivia with her\./);assert.doesNotMatch(out,/main character energy|@@TTSTAG/);
  const calls=fs.readFileSync(receipt,'utf8').trim().split('\n').map(JSON.parse),repair=calls.filter(b=>b.model.includes('glm'));
  assert.equal(repair.length,1,log);assert.match(repair[0].messages[0].content,/stock personal labels/);assert.match(repair[0].messages[0].content,/Leave unaffected sentences alone/);
 }finally{child.kill();await new Promise(r=>child.once('exit',r));}
});
