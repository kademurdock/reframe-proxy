const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {detectSlop}=require('./slop-filter');
const labels=text=>detectSlop(text).matches.filter(m=>m.pattern==='internet_label');
test('specific stock judgments from synthetic production replies are identified',()=>{
 for(const text of ["That's some main character energy right there.","That's some impressive mental gymnastics.","That is main character syndrome.","%%%amused%%% That's pure mental gymnastics."]){
  const m=labels(text);assert.equal(m.length,1);assert.equal(text.slice(...m[0].span),m[0].text);
 }
});
test('literary discussion, quoted phrases, code and ordinary opinions survive',()=>{
 for(const text of ['The main character has enormous energy.', 'Main character energy is a popular phrase.', "The phrase that's some main character energy annoys me.", 'She wrote "That is main character energy" in the review.', 'He said “That is mental gymnastics.”', '`That is main character energy`', 'The guide needs two extra steps.', 'I like her. I still think she was wrong.'])assert.equal(labels(text).length,0,text);
});
test('actual rewrite prompt preserves speech texture and limits unrelated edits',()=>{
 const s=fs.readFileSync(require.resolve('./server.js'),'utf8'),ctx={};
 vm.runInNewContext(s.slice(s.indexOf('const PATTERN_GUIDANCE ='),s.indexOf('// Aug 10 2026 — HER STUCK TEMP CHAT'))+'\nthis.prompt=buildRewriteSystemPrompt;',ctx);
 const prompt=ctx.prompt(labels("That's some main character energy."),true);
 assert.match(prompt,/specific action or disagreement/);assert.match(prompt,/Leave unaffected sentences alone/);assert.match(prompt,/first-person opinions, contractions, dialect, profanity/);assert.match(prompt,/@@TTSTAG0@@/);
});
