'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {voicePerformanceNoteFor}=require('./voice-performance');
const {conversationGuidanceFor, PILOT_MARKER}=require('./conversation-judgment');
// Exercise the rollback/pilot lane as well as the shipped default below.
process.env.KADE_CONVERSATION_JUDGMENT='pilot';
const source=fs.readFileSync(require.resolve('./server.js'),'utf8');
const context={conversationGuidanceFor,talkRegisterNoteFor:()=>'',trustListenerNoteFor:()=>'',learnLyricBody:()=>{},deepseekHabitNoteFor:()=>'',writingDeskFor:()=>'',WRITING_STYLE_NOTE:'craft',voicePerformanceNoteFor,voiceNoteFor:()=>'',isKianaBody:()=>false,isLyricBody:b=>b.lyric,
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
 assert.match(note,/An acknowledgment by itself is not a request to repeat/);
 assert.match(note,/open every spoken reply/);
 assert.ok(!note.includes('include one concrete vocal cue'));
 assert.equal(conversationGuidanceFor(body()),null);
 assert.equal(conversationGuidanceFor({messages:[{role:'user',content:PILOT_MARKER}]}),null);
 assert.equal(conversationGuidanceFor(pilot,{KADE_CONVERSATION_JUDGMENT:'0'}),null);
 assert.equal(conversationGuidanceFor({...pilot,response_format:{type:'json_schema'}}),null);
 assert.ok(conversationGuidanceFor(body(),{KADE_CONVERSATION_JUDGMENT:'1'}));
 assert.ok(conversationGuidanceFor(body(),{}),'conversation guidance is the shipped default');
 const blocks=body();blocks.messages[0].content=[{type:'text',text:'Character\n'+PILOT_MARKER}];
 assert.match(context.append(blocks).messages.at(-1).content,/An acknowledgment by itself is not a request to repeat/);
 for(const flag of ['lyric','compaction','keeper','machine','title']) {
  assert.ok(!JSON.stringify(context.append({...pilot,[flag]:true})).includes('An acknowledgment by itself is not a request to repeat'));
 }
});

test('actual prompt tails separate style criticism from brevity and continue substantive questions',()=>{
 const previous=context.conversationGuidanceFor;
 const register=context.talkRegisterNoteFor;
 context.talkRegisterNoteFor=require('./talk-register').talkRegisterNoteFor;
 try {
  for(const casual of ['0','1']) {
   context.conversationGuidanceFor=b=>conversationGuidanceFor(b,{KADE_CONVERSATION_JUDGMENT:'1',KADE_CASUAL_HOUSE:casual});
   for(const said of ['That sounds like a textbook. Why does the rhyme work?', 'Please use paragraphs. Tell me your take on the album.', 'Got it. What made that song so different?', 'Keep this answer short.']) {
    const input=body({model:'openai/gpt-6.1-sol',messages:[{role:'system',content:'You are Kiana, the flagship intelligence of Kade-AI.\nOld reaction: shorter replies worked once.'},{role:'user',content:said}]});
    const result=context.append(input),note=result.messages.at(-1).content;
    assert.equal(result.messages.length,input.messages.length+1);
    input.messages.forEach((message,index)=>assert.equal(result.messages[index],message));
    assert.match(note,/standalone simple correction/);
    assert.match(note,/direct request for less/);
    assert.match(note,/Follow any accompanying substantive question with the room it needs/);
    assert.match(note,/tone, wording or format/);
    assert.match(note,/requested substance/);
    assert.match(note,/Only treat it as a request to shorten when they actually ask for less/);
    assert.match(note,/past reaction to one answer never becomes a standing cap/);
    assert.match(note,/several paragraphs without an explicit request/);
    assert.match(note,/explicit request for a brief or quick answer/);
    assert.doesNotMatch(note,/reaction to your verbosity|how much you wrote usually gets|often shorter/);
    assert.ok(note.endsWith(require('./talk-register').SOL_CHARACTER_NOTE));
   }
  }
 } finally {context.conversationGuidanceFor=previous;context.talkRegisterNoteFor=register;}
});

test('the real SDK-converted developer request receives the full Sol conversation tail',()=>{
 const fixture=require('./test-fixtures/sol-character-wire.json');
 assert.match(fixture.generatedBy,/@librechat\/agents@3\.2\.46 _convertMessagesToOpenAIParams/);
 assert.deepEqual(fixture.body.messages.map(message=>message.role),['developer','user']);
 const previous=context.conversationGuidanceFor,register=context.talkRegisterNoteFor,trust=context.trustListenerNoteFor,title=context.isTitleShapedBody;
 const notes=require('./talk-register');
 context.isSolCharacterBody=notes.isSolCharacterBody;
 vm.runInNewContext(source.slice(source.indexOf('function isTitleShapedBody(body)'),source.indexOf('/* Aug 20 2026 — THE CADENCE STEER'))+'\nthis.isTitleShapedBody=isTitleShapedBody;',context);
 try {
  assert.equal(context.isTitleShapedBody(fixture.body),false);
  for(const titleBody of [
   {model:fixture.body.model,messages:[{role:'user',content:'I am the flagship intelligence of Kade-AI. Name this chat.'}]},
   {model:fixture.body.model,messages:[{role:'assistant',content:fixture.body.messages[0].content}]},
   {model:fixture.body.model,messages:[{role:'tool',content:fixture.body.messages[0].content}]},
   {model:fixture.body.model,messages:[{role:'system',content:'For the checkpoint: today is Monday.'},{role:'user',content:'Name this chat.'}]},
   {model:fixture.body.model,messages:[{role:'developer',content:'You generate conversation titles.'},{role:'user',content:'Name this chat.'}]},
  ])assert.equal(context.isTitleShapedBody(titleBody),true);
  for(const casual of ['0','1']) {
   const env={KADE_CONVERSATION_JUDGMENT:'1',KADE_CASUAL_HOUSE:casual};
   context.conversationGuidanceFor=b=>conversationGuidanceFor(b,env);
   context.talkRegisterNoteFor=b=>notes.talkRegisterNoteFor(b,env);
   context.trustListenerNoteFor=b=>notes.trustListenerNoteFor(b,env);
   const result=context.append(fixture.body),tail=result.messages.at(-1).content;
   assert.equal(result.messages.length,fixture.body.messages.length+1);
   fixture.body.messages.forEach((message,index)=>assert.equal(result.messages[index],message));
   assert.ok(tail.endsWith(notes.SOL_CHARACTER_NOTE));
   assert.match(tail,/several paragraphs without an explicit request/);
   assert.doesNotMatch(tail,/often shorter|few sentences is a normal turn|If a sentence is only there to connect/);
   assert.equal(notes.trustListenerNoteFor(fixture.body,env),'');
  }
 } finally {context.conversationGuidanceFor=previous;context.talkRegisterNoteFor=register;context.trustListenerNoteFor=trust;context.isTitleShapedBody=title;delete context.isSolCharacterBody;}
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
