/* Part 179 (Sep 11 2026): the keeper belt is carved out of the REPLY-side
 * slop pass, not only appendReminder. Read off the live reframe log at the
 * 12:00Z consolidation sweep: user_echo (Part 178) tripped on every bucket
 * ("I reviewed the agent bucket against the read-only shared cards", "The
 * July 11 birthday is already captured in personal_info") and each one ran
 * the rewrite twice. Those bodies carry the keeper toolbelt; the machine
 * prompt is the "user" text, and a model restating it is not an echo. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { isMemoryKeeperShapedBody } = require('./keeper');

const belt = (names) => names.map((n) => ({ type: 'function', function: { name: n } }));

test('a consolidation body (keeper belt, machine prompt as the user turn) is keeper-shaped', () => {
  const body = {
    model: 'z-ai/glm-5.3-flash',
    tools: belt(['set_memory', 'delete_memory', 'log_diary']),
    messages: [
      { role: 'system', content: 'You are the memory consolidation pass.' },
      { role: 'user', content: 'Review the agent bucket against the read-only shared cards: ...' },
    ],
  };
  assert.equal(isMemoryKeeperShapedBody(body), true);
  assert.equal(isMemoryKeeperShapedBody({ messages: body.messages, tools: belt(['web_search', 'set_memory']) }), false, 'a real agent with a memory tool is not the keeper');
  assert.equal(isMemoryKeeperShapedBody({ messages: body.messages }), false);
});

test('detectAndRewrite skips the keeper belt right after the swept machine lanes, before any detector runs', () => {
  const src = fs.readFileSync(require.resolve('./server.js'), 'utf8');
  const fn = src.slice(src.indexOf('async function detectAndRewrite('), src.indexOf('const matches = collectMatches(content, upstreamBody);'));
  assert.match(fn, /isSweptMachineBody\(upstreamBody\)/);
  assert.match(fn, /isMemoryKeeperShapedBody\(upstreamBody\)/);
  assert.ok(fn.indexOf('isSweptMachineBody(upstreamBody)') < fn.indexOf('isMemoryKeeperShapedBody(upstreamBody)'));
  assert.match(fn, /KEEPER_OUT_CARVEOUT && isMemoryKeeperShapedBody/);
  assert.match(src, /const KEEPER_OUT_CARVEOUT = process\.env\.KADE_KEEPER_OUT_CARVEOUT !== '0'/);
  assert.match(fn, /keeper-belt machine lane .* reply detection and rewrite skipped/);
});
