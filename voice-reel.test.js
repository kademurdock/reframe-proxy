'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { detectSlop } = require('./slop-filter');
const { detect: detectReframes } = require('./reframe-filter');
const { detectPersonaParrot, detectEchoGuard } = require('./echo-guard');
const { adaptForMimo } = require('./mimo');

const reel = require('./voice-reel');
const { REEL, HEADER, MIN_POOL, withVoiceReel, voiceCardFor, reelOnWire, reelLinesFor, loadPools, validPool, SWEAR_RE } = reel;

const POOLS = loadPools(path.join(__dirname, 'voice-reel'));
const ON = { KADE_VOICE_REEL: '1', KADE_VOICE_CARD: '1', KADE_VOICE_REEL_DRAFTS: '1' };
const KIANA_HEAD = 'house notes\n\nYou\'re Kiana, the flagship intelligence of Kade-AI.\n## 3. How you talk\n...';
const ADULT = '\n\n---\nThis is an audience note... the person you\'re talking to is a verified adult.';
const CHILD = '\n\n---\nAUDIENCE NOTE (invisible): this user is under 15. Keep your personality...';
const body = (said, head = KIANA_HEAD, extra = {}) => ({
  model: 'xiaomi/mimo-v2.6-pro',
  messages: [{ role: 'system', content: head }, { role: 'user', content: said }],
  ...extra,
});

// Both pools approved by Kade in chat, Nov 12 2026: Kiana ("Yes, turn them on"), Harley (she sent his
// lines: "handle how you see best"). The draft-path tests use unapproved copies.
const DRAFTS = POOLS.map((p) => ({ ...p, approved: false }));

// Nov 13 2026: five more pools, written and judged by Claude helpers, none of them hers yet. They
// stay "approved": false until she says so in chat, so they ride for nobody.
const APPROVED = ['harley', 'kiana'];
const DRAFT_IDS = ['angel', 'della', 'earl', 'lilly', 'witherspoon'];
const ALL_CLEAN = ['angel', 'lilly', 'witherspoon']; // a child may be on the other end, or the character is a child

test('every pool loads and is big enough clean; only the two she approved are approved', () => {
  assert.deepStrictEqual(POOLS.map((p) => p.id).sort(), [...APPROVED, ...DRAFT_IDS].sort());
  for (const p of POOLS) {
    if (APPROVED.includes(p.id)) assert.strictEqual(p.approved, true, p.id + ': approved by her word on Nov 12 2026');
    else assert.strictEqual(p.approved, false, p.id + ': a draft until she approves it');
    assert.ok(p.lines.filter((l) => !l.salty).length >= MIN_POOL, p.id + ' has too few clean lines');
  }
});

test('the Nov 13 drafts: found by their own persona opening, silent until approved, and three of them wholly clean', () => {
  const HEADS = {
    angel: 'You are Angel, an original fictional AI cherub girl: a tiny, sparkly child angel',
    della: '1. WHO YOU ARE\n\nYou are Della. Della Mae Whitfield, if somebody wants the whole thing',
    earl: 'You are Earl, 72, a retired long-haul trucker out of the Ozarks.',
    lilly: '# Lilly\n\n## Who You Are\nYou are Lilly, a 12-year-old girl from the Missouri Ozarks, in sixth grade this year.',
    witherspoon: "You are Mrs. Olivia Witherspoon, the librarian of Kade-AI's shared collection.",
  };
  reel._setPoolsForTest(POOLS);
  for (const id of DRAFT_IDS) {
    const p = POOLS.find((x) => x.id === id);
    const b = body('hey you', 'house notes\n\n' + HEADS[id] + ADULT);
    assert.strictEqual(withVoiceReel(b, { KADE_VOICE_REEL: '1' }), b, id + ' must not ride while unapproved');
    assert.deepStrictEqual(reelLinesFor(b, { KADE_VOICE_REEL: '1' }), []);
    const out = withVoiceReel(b, { KADE_VOICE_REEL: '1', KADE_VOICE_REEL_DRAFTS: '1' });
    assert.strictEqual(out[REEL].id, id, id + ' is matched by its own persona opening and by no other pool');
    assert.strictEqual(out[REEL].pairs.length, 4);
    assert.ok(p.lines.length >= 20 && p.lines.length <= 25, id + ' has ' + p.lines.length + ' lines');
    if (ALL_CLEAN.includes(id)) assert.strictEqual(p.lines.filter((l) => l.salty).length, 0, id + ' must have no adult-only line');
    // the website's cleaner deletes these sentences, so a line that leans on them would teach a hole
    for (const l of p.lines) assert.ok(!/\bI(?:'m| am) an AI\b|(?:^|[.!?]\s+)I don't have (?:a body|feelings|opinions|experiences)/i.test(l.you), l.id);
  }
  // Kiana's and Harley's heads still find their own pools with seven on disk
  assert.strictEqual(withVoiceReel(body('hey you'), { KADE_VOICE_REEL: '1' })[REEL].id, 'kiana');
});

test('no more than half of a pool\'s lines end on a question, for the whole pool and for the clean lines alone', () => {
  const endsOnQuestion = (l) => /\?["”’']?\s*$/.test(l.you);
  for (const p of POOLS) {
    for (const [name, lines] of [['all', p.lines], ['clean', p.lines.filter((l) => !l.salty)]]) {
      const n = lines.filter(endsOnQuestion).length;
      assert.ok(n * 2 <= lines.length, `${p.id} (${name}): ${n} of ${lines.length} lines end on a question, which teaches a closing question`);
    }
  }
});

test('with nothing switched on, unapproved pools change no request and add no parrot lines', () => {
  reel._setPoolsForTest(DRAFTS);
  const b = body('hey you');
  for (const env of [{}, { KADE_VOICE_REEL: '1' }, { KADE_VOICE_CARD: '1' }, { KADE_VOICE_REEL: '1', KADE_VOICE_CARD: '1' }]) {
    assert.strictEqual(withVoiceReel(b, env), b);
    assert.strictEqual(voiceCardFor(b, env), '');
    assert.deepStrictEqual(reelLinesFor(b, env), []);
    assert.strictEqual(reelOnWire(withVoiceReel(b, env)), b);
  }
  // an approved pool still needs the switch
  reel._setPoolsForTest(POOLS.map((p) => ({ ...p, approved: true })));
  assert.strictEqual(withVoiceReel(b, {}), b);
  assert.strictEqual(withVoiceReel(b, { KADE_VOICE_REEL: '1' })[REEL].id, 'kiana');
  reel._setPoolsForTest(POOLS);
});

test('the echo guard is the call it was when no reel lines are passed', () => {
  const sys = 'Persona.\n\nThem: so which one\nYou: One record for a desert island, it\'s Jolene, no contest.';
  const b = { messages: [{ role: 'system', content: sys }, { role: 'user', content: 'Dolly or Whitney?' }] };
  const reply = "One record for a desert island, it's Jolene, no contest.";
  assert.deepStrictEqual(detectEchoGuard(reply, b, { humanText: 'Dolly or Whitney?', exampleLines: [] }), detectEchoGuard(reply, b, { humanText: 'Dolly or Whitney?' }));
  const withReel = detectEchoGuard('Your eyes lying to you, basically. Anyway what else.', b, { exampleLines: ['Your eyes lying to you, basically. Moon the same size all night.'] });
  assert.strictEqual(withReel.filter((m) => m.pattern === 'persona_parrot').length, 1);
  assert.strictEqual(detectEchoGuard(reply, b, { exampleLines: ['Some other line that has nothing to do with it at all.'] }).filter((m) => m.pattern === 'persona_parrot').length,
    detectEchoGuard(reply, b, {}).filter((m) => m.pattern === 'persona_parrot').length, 'the persona\'s own examples are still checked beside the reel lines');
});

test('every line and card reads clean on the platform\'s own detectors and shows no contrast shape', () => {
  for (const p of POOLS) {
    for (const text of [...p.lines.map((l) => l.you), p.card]) {
      const slop = detectSlop(text).matches.map((m) => m.pattern + ': ' + m.text);
      assert.deepStrictEqual(slop, [], p.id + ' / ' + text.slice(0, 40) + ' -> ' + slop.join('; '));
      const found = detectReframes(text);
      const reframes = (Array.isArray(found) ? found : found.matches || []).map((m) => (m.pattern || m.name || 'reframe') + ': ' + (m.text || ''));
      assert.deepStrictEqual(reframes, [], p.id + ' / ' + text.slice(0, 40) + ' -> ' + reframes.join('; '));
      assert.ok(!/\bhonestly\b|that's not nothing|here's the thing|the part where/i.test(text), 'a named tic in: ' + text);
    }
  }
});

/* Review, Nov 12: three drafts said what the speaker is NOT doing and then what they are ("I ain't
 * saying don't. I'm saying ...", "I ain't writing nothing down, I'm talking"). The detectors above
 * do not see that shape, and a seed turn is where a model copies from. */
test('review: no line or card knocks an idea down and then says the real one', () => {
  const DENY_THEN_SAY = /\b(?:ain't|isn't|not|don't|wasn't)\b[^.!?]*[,.;]\s+(?:i'm|i am|it's|that's|he's|she's|they're|you're)\s/i;
  const SAY_THEN_DENY = /\b(?:i'm|it's|that's|he's|she's)\b[^.!?,]*,\s+(?:i|it|that|he|she)\s+(?:ain't|isn't|am not|is not)\b/i;
  assert.ok(DENY_THEN_SAY.test("I ain't saying don't. I'm saying I'd wanna know."), 'the pattern sees the old k10');
  assert.ok(DENY_THEN_SAY.test("I ain't writing nothing down, I'm talking"), 'the pattern sees the old Kiana card');
  assert.ok(SAY_THEN_DENY.test("I'm talking across a tailgate, I ain't writing for the paper"), 'the pattern sees the old Harley card');
  for (const p of POOLS) {
    for (const text of [...p.lines.map((l) => l.you), p.card]) {
      assert.ok(!DENY_THEN_SAY.test(text) && !SAY_THEN_DENY.test(text), p.id + ' / ' + text.slice(0, 60));
    }
  }
});

test('no line calls the listener by a pet name, and no clean line or card swears', () => {
  const PET = /\b(?:girl|sis|baby|babe|hon|honey|sugar|darlin'?|boo|bro|man|dude|buddy|kiddo)\b[,.!?]/i;
  for (const p of POOLS) {
    assert.ok(!SWEAR_RE.test(p.card), p.id + ' card must be clean for every audience');
    for (const l of p.lines) {
      assert.ok(!PET.test(l.you), 'pet name in ' + l.id);
      if (!l.salty) assert.ok(!SWEAR_RE.test(l.you), 'undeclared swear in ' + l.id);
    }
  }
});

test('a pool with an undeclared swear, a raw tag or a duplicate id is refused whole', () => {
  const ok = { id: 'x', match: 'You are Somebody Long Enough', lines: [{ id: 'a', them: 'hi', you: 'hey there you' }] };
  assert.strictEqual(validPool(ok), true);
  assert.strictEqual(validPool({ ...ok, lines: [{ id: 'a', them: 'hi', you: 'well damn' }] }), false);
  assert.strictEqual(validPool({ ...ok, lines: [{ id: 'a', them: 'hi', you: '%%%loud%%% hey' }] }), false);
  assert.strictEqual(validPool({ ...ok, lines: [ok.lines[0], ok.lines[0]] }), false);
  assert.strictEqual(validPool({ ...ok, card: 'hell yes' }), false);
});

test('off by default, off for an unapproved pool, off for other characters, JSON output and Sol', () => {
  reel._setPoolsForTest(DRAFTS);
  const b = body('hey you');
  assert.strictEqual(withVoiceReel(b, {}), b);
  assert.strictEqual(voiceCardFor(b, {}), '');
  assert.strictEqual(withVoiceReel(b, { KADE_VOICE_REEL: '1' }), b, 'draft pool must not ride without the drafts switch');
  assert.strictEqual(voiceCardFor(b, { KADE_VOICE_CARD: '1' }), '');
  const other = body('hey you', 'You are Earl. A retired lineman.');
  assert.strictEqual(withVoiceReel(other, ON), other);
  const json = body('hey you', KIANA_HEAD, { response_format: { type: 'json_object' } });
  assert.strictEqual(withVoiceReel(json, ON), json);
  const sol = { ...body('hey you'), model: 'openai/gpt-6.1-sol' };
  assert.strictEqual(withVoiceReel(sol, ON), sol);
});

test('the reel never changes body.messages; it rides a Symbol until the wire', () => {
  reel._setPoolsForTest(POOLS);
  const b = body('so how was your night');
  const out = withVoiceReel(b, ON);
  assert.deepStrictEqual(out.messages, b.messages, 'detectors, the think router and reply focus must see the real conversation');
  assert.strictEqual(out[REEL].id, 'kiana');
  assert.strictEqual(out[REEL].pairs.length, 4);
  assert.ok(!JSON.stringify(out).includes('VOICE REEL'), 'a Symbol key is invisible to JSON.stringify');
});

test('on the wire: seeds sit after the system head and before the real history, tags well formed', () => {
  reel._setPoolsForTest(POOLS);
  const b = { ...body('first thing I said'), messages: [
    { role: 'system', content: KIANA_HEAD },
    { role: 'user', content: 'first thing I said' },
    { role: 'assistant', content: 'a real reply' },
    { role: 'user', content: 'so how was your night' },
    { role: 'system', content: 'gateway tail' },
  ] };
  const wire = reelOnWire(adaptForMimo(withVoiceReel(b, ON))); // the Symbol must survive the adapter's spreads
  assert.strictEqual(wire.messages.length, 5 + 8);
  assert.strictEqual(wire.messages[0].role, 'system');
  for (let i = 1; i <= 8; i += 2) {
    assert.strictEqual(wire.messages[i].role, 'user');
    assert.ok(wire.messages[i].content.startsWith(HEADER));
    assert.strictEqual(wire.messages[i + 1].role, 'assistant');
    assert.match(wire.messages[i + 1].content, /^%%%[^%\n]+%%% \S/);
  }
  assert.deepStrictEqual(wire.messages.slice(9), b.messages.slice(1), 'the real conversation is byte for byte after the reel');
  assert.strictEqual(wire.messages[wire.messages.length - 1].content, 'gateway tail', 'the tail is still last');
  assert.strictEqual(reelOnWire(b), b, 'a body with no reel passes through as the same object');
});

test('one conversation keeps one reel across turns (cache), two conversations differ (rotation)', () => {
  reel._setPoolsForTest(POOLS);
  const turn1 = body('morning, what are we doing today');
  const turn3 = { ...turn1, messages: [...turn1.messages, { role: 'assistant', content: 'x' }, { role: 'user', content: 'ha, okay then' }] };
  assert.deepStrictEqual(withVoiceReel(turn3, ON)[REEL].ids, withVoiceReel(turn1, ON)[REEL].ids);
  const seen = new Set();
  for (let i = 0; i < 40; i++) seen.add(withVoiceReel(body('conversation number ' + i), ON)[REEL].ids.join(','));
  assert.ok(seen.size >= 30, 'only ' + seen.size + ' different reels in 40 conversations');
  const used = new Set([...seen].flatMap((s) => s.split(',')));
  assert.ok(used.size >= 11, 'rotation should reach nearly the whole clean pool, reached ' + used.size);
});

test('a line about the thing they just brought up sits that turn out', () => {
  reel._setPoolsForTest(POOLS);
  for (let i = 0; i < 40; i++) {
    const b = body('conversation number ' + i);
    const later = { ...b, messages: [...b.messages, { role: 'assistant', content: 'x' },
      { role: 'user', content: 'ugh my credit card, the sunset, my muddy mix, and the vaccine thing' }] };
    const ids = withVoiceReel(later, ON)[REEL].ids;
    for (const id of ['k09', 'k13', 'k14', 'k19']) assert.ok(!ids.includes(id), id + ' rode on a matching topic');
  }
});

test('salty lines ride only under the adult note; a child or untyped turn never gets one', () => {
  reel._setPoolsForTest(POOLS);
  const salty = new Set(POOLS.find((p) => p.id === 'kiana').lines.filter((l) => l.salty).map((l) => l.id));
  let adultSaw = 0;
  for (let i = 0; i < 60; i++) {
    const said = 'conversation number ' + i;
    for (const head of [KIANA_HEAD, KIANA_HEAD + CHILD, KIANA_HEAD + ADULT + CHILD]) {
      const out = withVoiceReel(body(said, head), ON);
      assert.ok(!out[REEL].ids.some((id) => salty.has(id)), 'salty line without an adult-only head');
      for (const p of out[REEL].pairs) assert.ok(!SWEAR_RE.test(p.assistant));
    }
    if (withVoiceReel(body(said, KIANA_HEAD + ADULT), ON)[REEL].ids.some((id) => salty.has(id))) adultSaw++;
  }
  assert.ok(adultSaw > 0, 'adults should hear the salty lines sometimes');
});

test('the card is the character\'s own first person, short, and reaches the parrot guard with the whole pool', () => {
  reel._setPoolsForTest(POOLS);
  const card = voiceCardFor(body('hey'), ON);
  assert.ok(card.startsWith('\n\n'));
  const n = card.trim().split(/\s+/).length;
  assert.ok(n >= 50 && n <= 110, 'card is ' + n + ' words');
  assert.match(card, /\bI\b/);
  assert.ok(!/["“”]/.test(card), 'a card quotes no sample reply');
  const lines = reelLinesFor(body('hey'), ON);
  assert.ok(lines.length >= 14 + 5);
  const copied = "Okay so. Nice don't tell you nothing about the car. Anyway what else.";
  const hits = detectPersonaParrot(copied, KIANA_HEAD, { exampleLines: lines });
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].pattern, 'persona_parrot');
  const fresh = 'Nah, I ain\'t heard that one yet. Who told you?';
  assert.deepStrictEqual(detectPersonaParrot(fresh, KIANA_HEAD, { exampleLines: lines }), []);
});

test('a conversation the character opened goes without the reel on the wire', () => {
  reel._setPoolsForTest(POOLS);
  const b = { model: 'xiaomi/mimo-v2.6-pro', messages: [
    { role: 'system', content: KIANA_HEAD },
    { role: 'assistant', content: 'hey, you up?' },
    { role: 'user', content: 'barely' },
  ] };
  const wire = reelOnWire(withVoiceReel(b, ON));
  assert.deepStrictEqual(wire.messages, b.messages);
});
