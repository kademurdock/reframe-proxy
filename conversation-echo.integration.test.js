'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {driftSteerNote}=require('./cadence-drift');
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const section=(start,end)=>{
  const a=source.indexOf(start), b=source.indexOf(end,a);
  assert.ok(a>=0 && b>a); return source.slice(a,b);
};
const context={driftSteerNote,DRIFT_STEER:true,console};
vm.runInNewContext(section('const DYNAMIC_TAIL_MARKERS =','\nfunction autoThinkPersonPick')+
  section('const CONTEXT_REPLAY_RE =','\nfunction autoThinkExcerpt')+
  section('function driftNoteFor(body)','\n/* ── COMPACTION DATE LAW')+'\nthis.note=driftNoteFor;',context);
const advice='Keep the blue toolbox on the lower garage shelf so the handle clears the cupboard door.';
const messages=[{role:'user',content:'Where should the blue toolbox fit in the garage?'},
  {role:'assistant',content:advice},{role:'user',content:'The new drummer leaves plenty of space for the bass.'},
  {role:'assistant',content:'That gives everyone more room.\n\n'+advice}];
test('production wrapper skips both file-search runtime shapes before or after the human',()=>{
  for(const prefix of ['- Note: Semantic search is available through the file_search tool but no files are currently loaded.',
    '- Note: Use the file_search tool to find relevant information within:']) {
    for(const before of [true,false]) {
      const human={role:'user',content:[{type:'text',text:'The bakery has started making excellent rye bread.'}]};
      const injected={role:'user',content:prefix+'\n toolboxes in the garage cupboard'};
      const body={messages:[...messages,...(before?[injected,human]:[human,injected]),
        {role:'assistant',content:'Checking now.',tool_calls:[{id:'t'}]},
        {role:'tool',tool_call_id:'t',content:'toolbox garage cupboard'}]};
      const original=JSON.stringify(body);
      assert.match(context.note(body),/Repetition note:/);
      assert.equal(JSON.stringify(body),original);
    }
  }
});
test('production wrapper removes replay context from human-topic classification only',()=>{
  const body={messages:[...messages,{role:'user',content:'[EARLIER IN THIS CONVERSATION — context only, toolbox garage cupboard. Reply ONLY to what follows.]\nThe bakery has started making excellent rye bread.'}]};
  assert.match(context.note(body),/Repetition note:/);
  assert.match(body.messages.at(-1).content,/EARLIER IN THIS CONVERSATION/);
});
