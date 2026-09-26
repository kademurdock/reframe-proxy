'use strict';

/* Part 293, the casual house (casual-house.js). Both texts of every gateway
 * house note are pinned by SHA-256: the classic text is d14b4b1's, byte for
 * byte, and the casual text is the one the offline A/B tested as arm F
 * (ab3/casual_*.txt and ab3/trust_listener.txt). The whole tail is then put
 * together from the real server.js source with the switch off and on, and
 * compared with d14b4b1's tail and with arm F's. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { casualHouseOn } = require('./casual-house');
const cj = require('./conversation-judgment');
const tr = require('./talk-register');
const ds = require('./deepseek');

const sha = s => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const OFF = { KADE_CASUAL_HOUSE: '0' };
const ON = { KADE_CASUAL_HOUSE: '1' };

/* classic = d14b4b1 (ab3/live_<piece>.txt, checked identical to the source
 * before the change); casual = ab3/casual_<piece>.txt. The clock pins carry
 * the frozen date below. */
const PINS = {
  deepseek_habit: ['2b32557bf3dbbbd9af0527a503b1b72c6f92a941e480fc3f913bf581c83ec463', 'cac8f6ee8fa2816052c4ff484522b517edacfdc39fd75eda05ca845ce4442528'],
  performance: ['6eac75879fb0a206d70d399d589e739a5730a05d8ea0d30f6ecbf46491c63b39', '61150665a0dbb46f61bcc838dca3c1861eb6d2f92246133f7a1580f0531f7583'],
  conversation: ['315cecb9179955c68510abff186334ecb7b6a47bc7efd919297da384c3dbb7b0', '8cd92b1fbe0fb110549bd603ad5e45d247db8a22cfd7ca2945d957be2949b166'],
  talk: ['6c5045630800fe486cb3485ef97334adfdb647a26437955c0b481f52af83d5af', '9e86804e5da81164d79142f1e36841bff9243b83c829a0e2b34f42ee2d9b5911'],
  explain: ['71dfcbc6467819db9a0bd19d0341a00e6289494440bf6fc1db5ba8ce03119056', '4378bd94e7b927ad0da01c1221b101c380cd85aa8f370aaa6357b8299e064593'],
  format: ['af6b61497ae346875c32d5ce2cdbbf3aa223a01a5d6988291ccfa17e4cb0c019', 'd7257c10f8d63a260764cc421cbef35f64ecdcc20d9ffb5064d948dbb1de33fd'],
  money: ['d1b2e31a7e3ea7b1f8bc7f5590f32cf9e1e9da6280e8f50c0d3b2fefa344292a', 'c7c9448cfb40e6df8faf7932c200b8d81c06a1d61d7f563c83f581db21c40036'],
  lane_text: ['65b97be1647910ddde2aca17385abe58e1bb8e16b20001dbcb5f930900b4fa92', '9e8e496d2ed5d05a78abc9efbca6b6672dd9bb54251888df8f50935bc2e3e810'],
  clock: ['039afc747f882f22903b054d3af120b893077ea0ae579974aabd6dddb02aa7d8', 'c26468d68df935c4059c6022d766246182bfb0342f1d54ac18a754737e01e420'],
  tool_web_search: ['4d9188f8a6420167378db4283bd02f85e6a1f2b9715ba5937fb3c7ea52c39bc9', 'e1babb70d494d729ab968d34e409eba3ff326b3232edbec2420843ef0fe0f5e6'],
  kiana_focus: ['133f33181a92aa2a4d4d9e5338d8039e353b4ae5ba8816a5fa2b601ef0151a7f', '49a8e4dcca92f5fc1c14ec9d564ce808fc0172fd0fbb000ecdbe5af3c04f4311'],
};
const TRUST_PIN = '074d0f50b5aed2d477ab35921002f8f6a80e2ba1a5c3778e2ce50d768e1514e5';
/* Whole tails for a Kiana turn on DeepSeek, text lane, conversation judgment
 * on: classic = arm B (d14b4b1), casual = arm F. */
const TAIL_PINS = {
  classic: {
    talk: '77644aa8529cada718dea2ce2e9ab8c78e0222b4460d397f7204c6b84e15028d',
    explain: '1570032ee623f6baa2661a105b078df60999475062e24f4d898501bcc7902da0',
    talkSearch: '083961bbdf49709752f69ba113f9d7f2c2af1ebd95060ac6db85e684e8c347e2',
  },
  casual: {
    talk: 'dd5198376671131a6acf1c85e002323c067283239ef523af87f35d3bb3c7ca14',
    explain: 'dda0a22a369473df2f6ac6e0208249a42fbbdc891612d78c1d99f869f49bb1ec',
    talkSearch: 'a2eebf5634998fb43eb62b6231dd25cf7c55f2596edd71a156fc25b6af8a46d1',
  },
};

// Friday, September 25, 2026 at 5:04 PM CDT, the date both arms carried.
const FIXED = Date.UTC(2026, 8, 25, 22, 4);
class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [FIXED]));
  }
}
// Newer ICU writes a narrow no-break space before PM; the pins use a space.
const plain = s => String(s).replace(/ /g, ' ');

const SERVER = fs.readFileSync(require.resolve('./server.js'), 'utf8');
function between(from, to) {
  const a = SERVER.indexOf(from);
  const b = SERVER.indexOf(to, a);
  assert.ok(a >= 0 && b > a, 'server.js anchors: ' + from + ' / ' + to);
  return SERVER.slice(a, b);
}

/* The tail notes and appendReminder, run from the server.js source with
 * CASUAL_HOUSE_ON set as the process would set it. The module notes get the
 * same switch through env. Everything unrelated to a plain conversation turn
 * is stubbed out. */
function server(casual, extraEnv = {}) {
  const env = { KADE_CASUAL_HOUSE: casual ? '1' : '0', ...extraEnv };
  const ctx = {
    process: { env: {} },
    Date: FixedDate,
    CASUAL_HOUSE_ON: casual,
    isPhoneTurn: b => Boolean(b.phone),
    isKianaBody: b => Boolean(b.kiana),
    writingDeskFor: () => '', isLyricBody: () => false, learnLyricBody: () => {}, LYRIC_OUTPUT_NOTE: '', WRITING_STYLE_NOTE: '',
    COMPACTION_DATE_ON: true, isCompactionShapedBody: () => false, compactionDateNote: () => '',
    KEEPER_CARVEOUT_ON: true, isMemoryKeeperShapedBody: () => false,
    isSweptMachineBody: () => false, isMemorySummaryShapedBody: () => false, isDiaryRepairShapedBody: () => false,
    isTitleShapedBody: () => false,
    STYLE_REMINDER: '[style reminder]', driftNoteFor: () => '', voiceNoteFor: () => '', voicePerformanceNoteFor: () => '',
    conversationGuidanceFor: b => cj.conversationGuidanceFor(b, env),
    deepseekHabitNoteFor: b => ds.deepseekHabitNoteFor(b, env),
    trustListenerNoteFor: b => tr.trustListenerNoteFor(b, env),
    talkRegisterNoteFor: b => tr.talkRegisterNoteFor(b, env),
    console: { log() {} },
  };
  vm.runInNewContext(
    between('const FORMAT_NOTE_ON', '/* ⚠️ TITLE / SUMMARIZER CALLS') + '\n' +
    between('function appendReminder(body)', '// -- TOOL SHIM') + '\n' +
    'this.notes = { format: FORMAT_NOTE, money: MONEY_NOTE, lane_text: laneNoteFor({}), clock: currentTimeNote(),' +
    ' tool_web_search: TOOL_NOTES.web_search, kiana_focus: KIANA_FOCUS_NOTE, phoneLane: laneNoteFor({ phone: true }) };' +
    ' this.append = appendReminder;',
    ctx);
  return { notes: ctx.notes, tail: body => plain(ctx.append(body).messages.at(-1).content) };
}

const turn = (said, extra = {}) => ({
  model: 'deepseek/deepseek-v4.1-flash',
  kiana: true,
  messages: [{ role: 'system', content: 'persona' }, { role: 'user', content: said }],
  ...extra,
});
const TALK_TURN = turn('lol my cat knocked the plant over again');
const EXPLAIN_TURN = turn('can you explain how a heat pump works');
const SEARCH_TURN = turn('lol my cat knocked the plant over again', { tools: [{ type: 'function', function: { name: 'web_search' } }] });

function moduleNotes(env) {
  const guidance = cj.conversationGuidanceFor({ messages: [] }, env);
  return {
    deepseek_habit: ds.deepseekHabitNoteFor({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }, env),
    performance: guidance.performance,
    conversation: guidance.conversation,
    talk: tr.talkRegisterNoteFor(TALK_TURN, env),
    explain: tr.talkRegisterNoteFor(EXPLAIN_TURN, env),
  };
}

test('the switch: on by default, 0 turns it off, a partial env follows the process', () => {
  const saved = process.env.KADE_CASUAL_HOUSE;
  try {
    delete process.env.KADE_CASUAL_HOUSE;
    assert.equal(casualHouseOn(), true);
    assert.equal(casualHouseOn({}), true);
    assert.equal(casualHouseOn(ON), true);
    assert.equal(casualHouseOn({ KADE_CASUAL_HOUSE: 'yes' }), true);
    assert.equal(casualHouseOn(OFF), false);
    process.env.KADE_CASUAL_HOUSE = '0';
    assert.equal(casualHouseOn(), false);
    assert.equal(casualHouseOn({}), false, 'an env that does not name the switch follows the process');
    assert.equal(casualHouseOn(ON), true, 'an env that names it wins');
  } finally {
    if (saved === undefined) delete process.env.KADE_CASUAL_HOUSE;
    else process.env.KADE_CASUAL_HOUSE = saved;
  }
});

test('switch off: every module note is the d14b4b1 text, byte for byte', () => {
  const notes = moduleNotes(OFF);
  for (const [name, text] of Object.entries(notes)) assert.equal(sha(text), PINS[name][0], name);
  assert.equal(notes.deepseek_habit, ds.DEEPSEEK_HABIT_NOTE_CLASSIC);
  assert.equal(notes.conversation, cj.CONVERSATION_NOTE_CLASSIC);
  assert.equal(notes.performance, cj.PERFORMANCE_NOTE_CLASSIC);
  assert.equal(notes.talk, tr.TALK_NOTE_CLASSIC);
  assert.equal(notes.explain, tr.EXPLAIN_NOTE_CLASSIC);
});

test('switch on: every module note is the casual text the A/B tested', () => {
  const notes = moduleNotes(ON);
  for (const [name, text] of Object.entries(notes)) assert.equal(sha(text), PINS[name][1], name);
  assert.equal(notes.deepseek_habit, ds.DEEPSEEK_HABIT_NOTE_CASUAL);
  assert.equal(notes.conversation, cj.CONVERSATION_NOTE_CASUAL);
  assert.equal(notes.performance, cj.PERFORMANCE_NOTE_CASUAL);
  assert.equal(notes.talk, tr.TALK_NOTE_CASUAL);
  assert.equal(notes.explain, tr.EXPLAIN_NOTE_CASUAL);
  assert.equal(sha(tr.TRUST_LISTENER_NOTE), TRUST_PIN);
});

test('server.js tail notes: off is d14b4b1, on is the casual text the A/B tested', () => {
  const off = server(false).notes;
  const on = server(true).notes;
  for (const name of ['format', 'money', 'lane_text', 'clock', 'tool_web_search', 'kiana_focus']) {
    assert.equal(sha(plain(off[name])), PINS[name][0], name + ' off');
    assert.equal(sha(plain(on[name])), PINS[name][1], name + ' on');
  }
  assert.equal(off.phoneLane, '');
  assert.equal(on.phoneLane, '', 'phone turns still get no lane note');
});

test('the exported texts follow the process switch, and server.js reads it once', () => {
  const casual = casualHouseOn();
  assert.equal(ds.DEEPSEEK_HABIT_NOTE, casual ? ds.DEEPSEEK_HABIT_NOTE_CASUAL : ds.DEEPSEEK_HABIT_NOTE_CLASSIC);
  assert.equal(cj.CONVERSATION_NOTE, casual ? cj.CONVERSATION_NOTE_CASUAL : cj.CONVERSATION_NOTE_CLASSIC);
  assert.equal(cj.PERFORMANCE_NOTE, casual ? cj.PERFORMANCE_NOTE_CASUAL : cj.PERFORMANCE_NOTE_CLASSIC);
  assert.equal(tr.TALK_NOTE, casual ? tr.TALK_NOTE_CASUAL : tr.TALK_NOTE_CLASSIC);
  assert.equal(tr.EXPLAIN_NOTE, casual ? tr.EXPLAIN_NOTE_CASUAL : tr.EXPLAIN_NOTE_CLASSIC);
  assert.equal(SERVER.split('const CASUAL_HOUSE_ON = casualHouseOn();').length, 2);
});

test('the whole tail: off is byte-identical to d14b4b1, on is arm F', () => {
  for (const [mode, casual] of [['classic', false], ['casual', true]]) {
    const { tail } = server(casual);
    assert.equal(sha(tail(TALK_TURN)), TAIL_PINS[mode].talk, mode + ' talk');
    assert.equal(sha(tail(EXPLAIN_TURN)), TAIL_PINS[mode].explain, mode + ' explain');
    assert.equal(sha(tail(SEARCH_TURN)), TAIL_PINS[mode].talkSearch, mode + ' talk with web_search');
  }
});

test('trust the listener sits right before the talk note, on talk turns only', () => {
  const on = server(true).tail;
  const talk = on(TALK_TURN);
  assert.ok(talk.endsWith(cj.CONVERSATION_NOTE_CASUAL + tr.TRUST_LISTENER_NOTE + tr.TALK_NOTE_CASUAL), 'conversation, trust, then talk last');
  assert.equal(talk.split(tr.TRUST_LISTENER_NOTE).length, 2, 'once');
  // other characters and models: still right before talk
  const plainTurn = { model: 'x-ai/grok-4.20', messages: TALK_TURN.messages };
  assert.ok(on(plainTurn).endsWith(tr.TRUST_LISTENER_NOTE + tr.TALK_NOTE_CASUAL));
  // explain turns never get it
  const explain = on(EXPLAIN_TURN);
  assert.ok(!explain.includes(tr.TRUST_LISTENER_NOTE));
  assert.ok(explain.endsWith(cj.CONVERSATION_NOTE_CASUAL + tr.EXPLAIN_NOTE_CASUAL));
  // switch off: gone, and talk is the classic text
  const off = server(false).tail(TALK_TURN);
  assert.ok(!off.includes(tr.TRUST_LISTENER_NOTE));
  assert.ok(off.endsWith(cj.CONVERSATION_NOTE_CLASSIC + tr.TALK_NOTE_CLASSIC));
  // no talk note, no trust note
  const noRegister = server(true, { KADE_TALK_REGISTER: '0' }).tail(TALK_TURN);
  assert.ok(!noRegister.includes(tr.TRUST_LISTENER_NOTE));
  assert.ok(noRegister.endsWith(cj.CONVERSATION_NOTE_CASUAL));
});

test('technical tokens survive exactly in both texts', () => {
  const off = { ...moduleNotes(OFF), ...server(false).notes };
  const on = { ...moduleNotes(ON), ...server(true).notes };
  const tokens = {
    performance: ['%%%direction%%%', '%%%laugh%%%', '%%%sigh%%%'],
    lane_text: ['%%%...%%%', 'go ahead, I\'m listening', 'you\'re on the line with...'],
    money: ['50 cents to a dollar each', '75 cents', 'Feed the Server page (bottom-left account menu)', 'first name'],
    tool_web_search: ['web_search'],
    clock: ['Friday, September 25, 2026 at 5:04', 'CDT (US Central)', '"tomorrow" or "tonight"'],
    conversation: ['"Please don\'t call me sweetheart"', '"Got it. I\'ll use your name."', '"Mylo is spelled with a y"',
      '"Glad Mylo\'s home."', '"How does a disk store gigglebytes?"', '"anything else"'],
    deepseek_habit: ["isn't, not just or not about", 'Say Y straight out as your own claim and keep going.'],
    format: ['screen reader', 'bold, color, alignment, tables'],
  };
  for (const [name, list] of Object.entries(tokens)) {
    for (const token of list) {
      assert.ok(plain(off[name]).includes(token), `${name} off keeps ${token}`);
      assert.ok(plain(on[name]).includes(token), `${name} on keeps ${token}`);
    }
  }
});

test('the casual texts drop the spec register: no labels, colons or double dashes', () => {
  const on = { ...moduleNotes(ON), ...server(true).notes, trust: tr.TRUST_LISTENER_NOTE };
  const clock = on.clock.replace(/\d{1,2}:\d{2}/, 'TIME');
  for (const [name, text] of Object.entries({ ...on, clock })) {
    assert.ok(!text.includes(':'), name + ' has a colon');
    assert.ok(!text.includes('--'), name + ' has a double dash');
    assert.ok(!/RIGHT NOW|WRITTEN|IS attached|FIRST|THIS reply/.test(text), name + ' shouts');
  }
});
