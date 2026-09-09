'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {voicePerformanceNoteFor}=require('./voice-performance');
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const context={voicePerformanceNoteFor,voiceNoteFor:()=>'',isLyricBody:b=>b.lyric,
 LYRIC_OUTPUT_NOTE:'lyric',COMPACTION_DATE_ON:true,isCompactionShapedBody:b=>b.compaction,
 compactionDateNote:()=>'',KEEPER_CARVEOUT_ON:true,isMemoryKeeperShapedBody:b=>b.keeper,
 isSweptMachineBody:b=>b.machine,isMemorySummaryShapedBody:()=>true,isDiaryRepairShapedBody:()=>false,
 isTitleShapedBody:b=>b.title,toolNotesFor:()=>'',STYLE_REMINDER:'',FORMAT_NOTE_ON:false,
 MONEY_NOTE:'',laneNoteFor:()=>'',driftNoteFor:()=>'',currentTimeNote:()=>'',console:{log:()=>{}}};
vm.runInNewContext(source.slice(source.indexOf('function appendReminder(body)'),source.indexOf('// -- TOOL SHIM'))+'\nthis.append=appendReminder;',context);
const body=extras=>({messages:[{role:'system',content:'You are a character.'},{role:'user',content:'Hello.'}],...extras});
test('real prompt assembly adds performance guidance on conversation and phone lanes',()=>{
 for(const extra of [{},{phone:true}])assert.match(context.append(body(extra)).messages.at(-1).content,/Steady pace does not mean steady pitch/);
});
test('machine, title, keeper, compaction and lyric carveouts stay intact',()=>{
 for(const flag of ['lyric','compaction','keeper','machine','title']){
  assert.ok(!JSON.stringify(context.append(body({[flag]:true}))).includes('Voice performance:'));
 }
});
test('structured output and emergency switch omit the new performance note',()=>{
 assert.equal(voicePerformanceNoteFor(body({response_format:{type:'json_schema'}})),'');
 process.env.KADE_TTS_PERFORMANCE_NOTE='0';try{assert.equal(voicePerformanceNoteFor(body()),'');}finally{delete process.env.KADE_TTS_PERFORMANCE_NOTE;}
});
test('performance guidance preserves explicit calm/deadpan, continuity, identity and artifact boundaries',()=>{
 const note=voicePerformanceNoteFor(body());
 for(const term of ['follow explicit delivery requests','without a tag quota','accent, personality','out of code'])assert.ok(note.includes(term));
});
