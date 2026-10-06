'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const keeper = require('./keeper');
const compaction = require('./compaction');
const machines = require('./machines');
const writing = require('./writing');
const register = require('./talk-register');
const { conversationGuidanceFor } = require('./conversation-judgment');
const { adaptForSol } = require('./sol');
const { adaptForGlm } = require('./modelbudget');
const fixture = require('./test-fixtures/sol-keeper-wire.json');
const source = fs.readFileSync(require.resolve('./server.js'), 'utf8');
const currentNames = ['set_memory', 'delete_memory', 'log_diary', 'record_person', 'forget_relationship_impressions'];

function runtime({ keeperIn = true, keeperOut = true } = {}) {
  const context = {
    ...keeper, ...compaction, ...machines,
    process: { env: {} },
    writingDeskFor: writing.writingDeskFor,
    WRITING_STYLE_NOTE: writing.WRITING_STYLE_NOTE,
    isSolCharacterBody: register.isSolCharacterBody,
    isLyricBody: () => false, learnLyricBody: () => {}, LYRIC_OUTPUT_NOTE: 'lyrics',
    COMPACTION_DATE_ON: true, KEEPER_CARVEOUT_ON: keeperIn, KEEPER_OUT_CARVEOUT: keeperOut,
    FORMAT_NOTE_ON: false, STYLE_REMINDER: 'style', MONEY_NOTE: 'money',
    toolNotesFor: () => '', laneNoteFor: () => '', driftNoteFor: () => '', currentTimeNote: () => '',
    isKianaBody: () => false, KIANA_FOCUS_NOTE: '', deepseekHabitNoteFor: () => '',
    voiceNoteFor: () => { throw new Error('legacy anchors should stay bypassed'); },
    voicePerformanceNoteFor: () => { throw new Error('legacy performance should stay bypassed'); },
    conversationGuidanceFor: body => conversationGuidanceFor(body, {}),
    trustListenerNoteFor: body => register.trustListenerNoteFor(body, {}),
    talkRegisterNoteFor: body => register.talkRegisterNoteFor(body, {}),
    scrubSearchArtifacts: text => text, normalizeVoiceTagTypos: text => text,
    COHERENCE_ON: false, styleDetectorReached: false,
    console: { log() {} },
  };
  vm.runInNewContext(
    source.slice(source.indexOf('function isTitleShapedBody(body)'), source.indexOf('/* Aug 20 2026 — THE CADENCE STEER')) + '\n' +
    source.slice(source.indexOf('function appendReminder(body)'), source.indexOf('// -- TOOL SHIM')) + '\n' +
    source.slice(source.indexOf('const TOOL_SHIM_MODELS ='), source.indexOf('const SHIM_CALL_RE =')) + '\n' +
    source.slice(source.indexOf('async function detectAndRewrite('), source.indexOf('  const observedMatches = collectMatches(content, upstreamBody);')) +
    '\nthis.styleDetectorReached = true; return result; }\nthis.append = appendReminder; this.rewrite = detectAndRewrite; this.shim = withToolShim;',
    context);
  return context;
}

const proseReply = () => ({ choices: [{ message: { content: 'Filed the supported preference after checking the existing card.' } }] });

test('the actual SDK five-tool developer wire gets no conversation tail, shim or reply detector', async () => {
  assert.match(fixture.generatedBy, /@librechat\/agents@3\.2\.46 ChatOpenRouter\.bindTools\/invocationParams/);
  assert.deepEqual(fixture.body.messages.map(message => message.role), ['developer', 'user']);
  assert.deepEqual(fixture.body.tools.map(tool => tool.function.name), currentNames);
  const context = runtime(), original = JSON.stringify(fixture.body);
  assert.equal(context.shim(fixture.body).active, false);
  assert.equal(context.shim(fixture.body).body, fixture.body);
  assert.equal(keeper.isMemoryKeeperShapedBody(fixture.body), true);
  assert.equal(context.append(fixture.body), fixture.body);
  const adapted = adaptForSol(adaptForGlm(fixture.body));
  assert.equal(adapted.tools, fixture.body.tools);
  assert.equal(adapted.messages, fixture.body.messages);
  assert.equal(adapted.reasoning.effort, 'low');
  assert.equal(adapted.max_completion_tokens, 16000);
  const reply = proseReply();
  assert.equal(await context.rewrite(reply, adapted), reply);
  assert.equal(context.styleDetectorReached, false);
  assert.equal(JSON.stringify(fixture.body), original);
});

test('legacy and optional recognition keeper belts remain model and instruction-role independent', async () => {
  for (const model of ['openai/gpt-6.1-sol', 'gpt-6.1-sol', 'z-ai/glm-5.3-flash', 'gpt-4.1-mini']) {
    for (const role of ['system', 'developer']) {
      for (const names of [currentNames.slice(0, 2), currentNames.slice(0, 3), [...currentNames.slice(0, 3), 'record_person'], [...currentNames.slice(0, 3), 'forget_relationship_impressions'], currentNames]) {
        const body = { ...fixture.body, model, messages: [{ role, content: 'A synthetic memory-keeper instruction.' }, fixture.body.messages[1]], tools: names.map(name => ({ type: 'function', function: { name } })) };
        const context = runtime();
        assert.equal(keeper.isMemoryKeeperShapedBody(body), true);
        assert.equal(context.append(body), body);
        assert.equal(await context.rewrite(proseReply(), body).then(() => context.styleDetectorReached), false);
      }
    }
  }
});

test('an unrelated extra tool or missing set_memory anchor keeps the ordinary conversation guards', async () => {
  for (const names of [[...currentNames, 'web_search'], ['record_person', 'forget_relationship_impressions'], ['kade_memory_search', 'kade_living_memory']]) {
    const body = { ...fixture.body, tools: names.map(name => ({ type: 'function', function: { name } })) };
    const context = runtime();
    assert.equal(keeper.isMemoryKeeperShapedBody(body), false);
    assert.equal(context.append(body).messages.length, body.messages.length + 1);
    await context.rewrite(proseReply(), body);
    assert.equal(context.styleDetectorReached, true);
  }
});

test('neighboring summary, writing, title, checkpoint and actual Sol character requests keep their own behavior', async () => {
  const context = runtime();
  const summary = { model: fixture.body.model, messages: [{ role: 'developer', content: 'Update the running summary.' }, { role: 'user', content: 'PREVIOUS SUMMARY (may be empty):\nNone.\nWrite the updated running summary now.' }] };
  assert.equal(context.append(summary), summary);
  await context.rewrite(proseReply(), summary);
  assert.equal(context.styleDetectorReached, false);
  const desk = { ...fixture.body, messages: [{ role: 'developer', content: "You are the script desk in Kade-AI's Sound Booth." }, { role: 'user', content: 'Write an original scene.' }] };
  assert.equal(context.append(desk).messages.at(-1).content, writing.WRITING_STYLE_NOTE);
  await context.rewrite(proseReply(), desk);
  assert.equal(context.styleDetectorReached, false);
  const title = { model: fixture.body.model, messages: [{ role: 'user', content: 'Name this chat.' }] };
  assert.equal(context.append(title), title);
  const checkpoint = { ...fixture.body, messages: [...fixture.body.messages.slice(0, 1), { role: 'user', content: 'Hold on again — update your checkpoint. Merge the latest messages.' }] };
  assert.equal(compaction.disarmCompaction(checkpoint).tools, undefined);
  assert.match(context.append(checkpoint).messages.at(-1).content, /^For the checkpoint: today is/);
  const character = { model: fixture.body.model, messages: [{ role: 'developer', content: 'You are Kiana, the flagship intelligence of Kade-AI.' }, { role: 'user', content: 'Talk with me.' }] };
  assert.equal(keeper.isMemoryKeeperShapedBody(character), false);
  assert.ok(context.append(character).messages.at(-1).content.endsWith(register.KIANA_SOL_REGISTER_NOTE));
});

test('the existing request and reply carveout switches still restore ordinary handling when disabled', async () => {
  const context = runtime({ keeperIn: false, keeperOut: false });
  assert.equal(context.append(fixture.body).messages.length, fixture.body.messages.length + 1);
  await context.rewrite(proseReply(), fixture.body);
  assert.equal(context.styleDetectorReached, true);
});
