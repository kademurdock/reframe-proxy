'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { measure, logLine, meterOn } = require('./voice-meter');
const { ticsOf } = require('./voice-lexicon');
const { characterOf } = require('./register-edit');

/* Half of these are about what the meter must NOT count (the Sep 21 rule for any detector). */
test('standard English scores zero, whatever it is about', () => {
  for (const t of [
    'Old dogs lose hearing the way old people do, high frequencies first. So that soft indoor voice is gone.',
    'We had cornbread at church and then sat on the porch. Are they going to the lake? I saw you running.',
    'He said they were going to say no. She doesn\'t know. I have been told that before.',
    'Give them apples and tell them things will be fine. Hello, class. It is done.',
    'If you want to see it look good, let it go slowly. Does he know? Did she get it?',
  ]) {
    const m = measure(t);
    assert.strictEqual(m.grammar + m.wordChoice + m.swears, 0, t + ' -> ' + JSON.stringify(m.kinds));
  }
});

test('each kind counts its own feature', () => {
  const one = (t, kind) => assert.ok(measure(t).kinds[kind] >= 1, kind + ' missed in: ' + t + ' ' + JSON.stringify(measure(t).kinds));
  one('Half of them ain\'t even thirsty.', 'aint');
  one('WATER, y\'all.', 'yall');
  one('She finna be unbearable at the gas station.', 'finna_tryna');
  one('You fixin\' to put one up yourself?', 'fixin_to');
  one('I\'d go lookin\' at the cable ends.', 'dropped_g');
  one('Oh, he know exactly what he doing.', 'plain_third');
  one('Who we talking about? You riding with her?', 'no_copula');
  one('Scientists still be arguing about it.', 'habitual_be');
  one('You don\'t owe nobody a whole Saturday.', 'double_neg');
  one('They was designed by an architect.', 'was_dont');
  one('Y\'all done changed the rules three times.', 'done_verb');
  one('I\'d look at them cable ends first.', 'them_those');
  one('You might could ted it.', 'might_could');
  one('I reckon that\'s worth it.', 'country_words');
  one('Nah, I\'m keeping that song.', 'street_words');
  one('Lord, that boy can eat.', 'interjection');
  one('That\'s a hell of a thing.', 'swear');
  one('I do. I come down on the side of the one doing the work.', 'own_position');
});

test('her own Oct 18 sample lines: the old-persona reply outscores the new one, as the record noted', () => {
  const before = 'WATER, y\'all. We turned DRINKING WATER into a personality. Half of them ain\'t even thirsty, they just want the cup to be visible. We all got our dumb flexes. But at least mine keeps the sun out my eyes.';
  const after = 'Some of them are shaped like they was designed by an architect who hates holding things. Can\'t fit \'em in a car cup holder. Meanwhile the tap in my kitchen is right there, cold and free and not judging anybody.';
  assert.ok(measure(before).grammar >= 2);
  assert.ok(measure(after).grammar >= 1);
  assert.ok(measure(before).dialectPer100 > measure(after).dialectPer100);
});

test('voice tags are not counted as words and the log line is one JSON object', () => {
  assert.strictEqual(measure('%%%dry, a little damn loud%%% Fine.').swears, 0);
  const line = logLine('abc123', 'kiana', 'text', 'Nah, he ain\'t coming.', { reel: ['k01'] });
  assert.ok(line.startsWith('[voice-meter] {'));
  const j = JSON.parse(line.slice('[voice-meter] '.length));
  assert.strictEqual(j.who, 'kiana');
  assert.strictEqual(j.grammar, 1);
  assert.deepStrictEqual(j.reel, ['k01']);
});

test('KADE_VOICE_METER=0 turns the meter off; anything else leaves it on', () => {
  assert.strictEqual(meterOn({}), true);
  assert.strictEqual(meterOn({ KADE_VOICE_METER: '1' }), true);
  assert.strictEqual(meterOn({ KADE_VOICE_METER: '0' }), false);
});

/* The glue in server.js, run from its real source with a captured console. */
function serverMeter(env = {}) {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const a = src.indexOf('function voiceMeterLog(');
  const b = src.indexOf('\n}\n', a) + 3;
  assert.ok(a > 0 && b > a, 'voiceMeterLog found in server.js');
  const lines = [];
  const voiceMeter = { measure, logLine, meterOn: () => meterOn(env) };
  const ctx = { voiceMeter, ticsOf, voiceMeterCharacterOf: characterOf, reelInfo: (body) => body.reel || null, console: { log: (l) => lines.push(l) } };
  vm.runInNewContext(src.slice(a, b) + '\nthis.run = voiceMeterLog;', ctx);
  return { run: ctx.run, lines };
}
const KIANA = { messages: [{ role: 'system', content: "You're Kiana, the flagship.\n\n## 3. How you talk\nLoose." }, { role: 'user', content: 'SECRET USER WORDS' }] };

test('server glue: one line per character reply, counts only, never the reply or the person\'s words', () => {
  const { run, lines } = serverMeter();
  const reply = 'Nah, he ain\'t coming, and honestly that purple umbrella was ugly anyway.';
  run('req1', KIANA, 'text', reply, { think: false }, 'He is not coming, and that purple umbrella was ugly anyway.');
  assert.strictEqual(lines.length, 1);
  const j = JSON.parse(lines[0].slice('[voice-meter] '.length));
  assert.deepStrictEqual(Object.keys(j).sort(), ['dialectPer100', 'draftPer100', 'grammar', 'kinds', 'lane', 'positions', 'req', 'swears', 'think', 'tics', 'who', 'wordChoice', 'words'].sort());
  assert.strictEqual(j.who, 'Kiana');
  assert.strictEqual(j.lane, 'text');
  assert.strictEqual(j.tics, 1);
  assert.strictEqual(j.draftPer100, 0);
  assert.ok(j.dialectPer100 > 0);
  for (const secret of ['umbrella', 'purple', 'SECRET', 'coming']) assert.ok(!lines[0].includes(secret), 'log line leaks text: ' + secret);
  for (const v of Object.values(j.kinds)) assert.strictEqual(typeof v, 'number');
});

test('server glue: no draft figure when no editor changed the reply; calls carry the host; a reel shows its ids', () => {
  const { run, lines } = serverMeter();
  run('r', KIANA, 'text', 'Nah, he ain\'t coming.', { think: true }, 'Nah, he ain\'t coming.');
  run('r', { ...KIANA, reel: { ids: ['k01', 'k03'] } }, 'call', 'Nah, he ain\'t coming.', { think: false, host: 'DeepInfra' });
  const [a, b] = lines.map((l) => JSON.parse(l.slice('[voice-meter] '.length)));
  assert.ok(!('draftPer100' in a));
  assert.strictEqual(a.think, true);
  assert.ok(!('reel' in a));
  assert.strictEqual(b.lane, 'call');
  assert.strictEqual(b.host, 'DeepInfra');
  assert.deepStrictEqual(b.reel, ['k01', 'k03']);
});

test('server glue: silent for a body with no named character, for empty text, when off, and when anything throws', () => {
  const on = serverMeter();
  on.run('r', { messages: [{ role: 'system', content: 'Summarise the following.' }] }, 'text', 'Nah, he ain\'t coming.');
  on.run('r', KIANA, 'text', '   ');
  on.run('r', KIANA, 'text', null);
  on.run('r', null, 'text', 'Nah.');
  assert.deepStrictEqual(on.lines, []);
  const off = serverMeter({ KADE_VOICE_METER: '0' });
  off.run('r', KIANA, 'text', 'Nah, he ain\'t coming.');
  assert.deepStrictEqual(off.lines, []);
});

test('server.js calls the meter on the typed lane after the editors and on the call lane, and logs the served model', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(src.includes("voiceMeterLog(result.id, upstreamBody, 'text', choice.message.content,"));
  assert.ok(src.includes("if (phoneLive && !toolMode) voiceMeterLog(reqId, upstreamBody, 'call', contentAccum,"));
  assert.ok(src.includes('const voiceDraft = content;'));
  assert.ok(src.indexOf('const voiceDraft = content;') < src.indexOf('const observedMatches = collectMatches(content, upstreamBody);'));
  const line = src.split('\n').find((l) => l.includes('served by provider='));
  assert.match(line, /model=\$\{upstreamModel \|\| '\(not reported\)'\}/);
  assert.ok(src.includes('sent: temp=${upstreamBody.temperature ?? \'-\'} top_p=${upstreamBody.top_p ?? \'-\'} max_tokens=${upstreamBody.max_tokens ?? \'-\'}'));
});
