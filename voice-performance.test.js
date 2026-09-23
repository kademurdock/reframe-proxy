'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {voicePerformanceNoteFor}=require('./voice-performance');
const {conversationGuidanceFor, PILOT_MARKER}=require('./conversation-judgment');
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const context={conversationGuidanceFor,learnLyricBody:()=>{},deepseekHabitNoteFor:()=>'',writingDeskFor:()=>'',WRITING_STYLE_NOTE:'craft',voicePerformanceNoteFor,voiceNoteFor:()=>'',isKianaBody:()=>false,isLyricBody:b=>b.lyric,
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

test('pilot replaces overlapping acting instructions without changing ordinary conversations',()=>{
 const pilot=body();pilot.messages[0].content += '\n'+PILOT_MARKER;
 const note=context.append(pilot).messages.at(-1).content;
 assert.match(note,/An acknowledgment is not a request to repeat/);
 assert.match(note,/open every spoken reply/);
 assert.ok(!note.includes('include one concrete vocal cue'));
 assert.equal(conversationGuidanceFor(body()),null);
 assert.equal(conversationGuidanceFor({messages:[{role:'user',content:PILOT_MARKER}]}),null);
 assert.equal(conversationGuidanceFor(pilot,{KADE_CONVERSATION_JUDGMENT:'0'}),null);
 assert.equal(conversationGuidanceFor({...pilot,response_format:{type:'json_schema'}}),null);
 assert.ok(conversationGuidanceFor(body(),{KADE_CONVERSATION_JUDGMENT:'1'}));
 const blocks=body();blocks.messages[0].content=[{type:'text',text:'Character\n'+PILOT_MARKER}];
 assert.match(context.append(blocks).messages.at(-1).content,/An acknowledgment is not a request to repeat/);
 for(const flag of ['lyric','compaction','keeper','machine','title']) {
  assert.ok(!JSON.stringify(context.append({...pilot,[flag]:true})).includes('An acknowledgment is not a request to repeat'));
 }
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
test('deepseek turns get the pacing note; other models and the kill switch do not',()=>{
 const ds=voicePerformanceNoteFor(body({model:'deepseek/deepseek-v4.1-flash'}));
 assert.match(ds,/Voice directions:/);assert.match(ds,/open every spoken reply with one/);assert.match(ds,/jump cut/);assert.match(ds,/Steady pace does not mean steady pitch/);
 assert.ok(!/%%%pause%%%/.test(ds),'timing directions are dropped by the speech proxy');
 assert.ok(!voicePerformanceNoteFor(body({model:'x-ai/grok-4.20'})).includes('Voice directions:'));
 process.env.KADE_DEEPSEEK_VOICE_PACING='0';try{assert.ok(!voicePerformanceNoteFor(body({model:'deepseek/deepseek-v4.1-flash'})).includes('Voice directions:'));}finally{delete process.env.KADE_DEEPSEEK_VOICE_PACING;}
});
