'use strict';
/* Part 97 — the tool-fumble escalator, pinned. Source-level in the house
 * style: stuckToolSignature extracted from the shipped server.js by vm, the
 * route wiring pinned by ordering assertions on comment-stripped source.
 * Red-proof: loosen the identical-content requirement, drop the model gate,
 * or move the escalator below the tool shim, and a test here fails. */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync(require.resolve('./server.js'), 'utf8');

function loadFn() {
  const start = src.indexOf('function stuckToolSignature(messages) {');
  assert.ok(start > -1, 'stuckToolSignature not found');
  let depth = 0, end = -1;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  const ctx = { TOOL_ESCALATE_REPEATS: 2 };
  vm.createContext(ctx);
  vm.runInContext(src.slice(start, end) + '\nthis.fn = stuckToolSignature;', ctx);
  return ctx.fn;
}
const stuck = loadFn();

const user = { role: 'user', content: 'remind me at 8:40' };
const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [{ id, function: { name, arguments: args } }] });
const result = (id, content) => ({ role: 'tool', tool_call_id: id, content });

test("THE AMBER SHAPE: same tool, identical rejection twice — it trips", () => {
  const msgs = [user,
    call('a', 'kade_notify', '{"time":"08:40"}'), result('a', "set_reminder needs either 'in_minutes' or 'fire_date'+'fire_time'."),
    call('b', 'kade_notify', '{"time":"08:40","days":"sat"}'), result('b', "set_reminder needs either 'in_minutes' or 'fire_date'+'fire_time'."),
  ];
  const v = stuck(msgs);
  assert.ok(v, 'should trip');
  assert.strictEqual(v.name, 'kade_notify');
  assert.strictEqual(v.repeats, 2);
});

test('two searches with DIFFERENT answers never trip', () => {
  const msgs = [user,
    call('a', 'kade_memory_search', '{"q":"concerts"}'), result('a', 'Found: Shinedown July 28.'),
    call('b', 'kade_memory_search', '{"q":"surgery"}'), result('b', 'Found: foot surgery scheduled.'),
  ];
  assert.strictEqual(stuck(msgs), null);
});

test('identical answers from DIFFERENT tools never trip', () => {
  const msgs = [user,
    call('a', 'tool_one', '{}'), result('a', 'nope'),
    call('b', 'tool_two', '{}'), result('b', 'nope'),
  ];
  assert.strictEqual(stuck(msgs), null);
});

test('a PREVIOUS turn\'s failures do not haunt the next turn', () => {
  const msgs = [
    { role: 'user', content: 'earlier ask' },
    call('a', 'kade_notify', '{}'), result('a', 'same error'),
    call('b', 'kade_notify', '{}'), result('b', 'same error'),
    { role: 'assistant', content: 'could not do it, sorry' },
    { role: 'user', content: 'ok try something else' },
  ];
  assert.strictEqual(stuck(msgs), null);
});

test('array-shaped tool content still matches', () => {
  const msgs = [user,
    call('a', 't', '{}'), { role: 'tool', tool_call_id: 'a', content: [{ type: 'text', text: 'same words' }] },
    call('b', 't', '{}'), { role: 'tool', tool_call_id: 'b', content: [{ type: 'text', text: 'same words' }] },
  ];
  assert.ok(stuck(msgs));
});

test('empty tool results never count toward a signature', () => {
  const msgs = [user,
    call('a', 't', '{}'), result('a', ''),
    call('b', 't', '{}'), result('b', ''),
  ];
  assert.strictEqual(stuck(msgs), null);
});

// ── wiring pins, comment-stripped ──
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('escalation is gated on the FROM model exactly', () => {
  assert.match(stripped, /TOOL_ESCALATE_ENABLED && req\.body\.model === TOOL_ESCALATE_FROM/);
});

test('the escalator runs BEFORE the tool shim', () => {
  const esc = stripped.indexOf('stuckToolSignature(req.body.messages)');
  const shim = stripped.indexOf('const shim = withToolShim(req.body)');
  assert.ok(esc > -1 && shim > -1 && esc < shim, `escalate@${esc} must precede shim@${shim}`);
});

test('the kill switch exists and defaults on', () => {
  assert.match(stripped, /KADE_TOOL_ESCALATE !== '0'/);
});
