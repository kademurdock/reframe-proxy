'use strict';
/**
 * The first test is the live keeper shape, because a fix that cannot
 * reproduce the bug it claims to fix is a guess. Tool names and schemas are
 * transcribed from packages/api/src/agents/memory.ts in the fork.
 */
const test = require('node:test');
const assert = require('node:assert');
const { isMemoryKeeperShapedBody } = require('./keeper.js');

const fn = (name) => ({ type: 'function', function: { name } });

/** What LibreChat's memory lane actually sends: three tools, one system message. */
const KEEPER_BODY = {
  model: 'z-ai/glm-4.5-air',
  temperature: 0.3,
  tools: [fn('set_memory'), fn('delete_memory'), fn('log_diary')],
  tool_choice: 'auto',
  messages: [
    { role: 'system', content: 'You are the platform\'s memory-keeper. '.repeat(200) },
    { role: 'user', content: 'okay random but why do they put those little plastic prizes in cereal boxes' },
    { role: 'assistant', content: 'Mostly nostalgia now — it is aimed at the parent.' },
  ],
};

test('THE OUTAGE, REPRODUCED: the live keeper body is recognised', () => {
  assert.strictEqual(isMemoryKeeperShapedBody(KEEPER_BODY), true);
});

test('the keeper without log_diary (diary lane off) is still the keeper', () => {
  assert.strictEqual(
    isMemoryKeeperShapedBody({ ...KEEPER_BODY, tools: [fn('set_memory'), fn('delete_memory')] }),
    true);
});

test('order does not matter — the toolbelt is a set', () => {
  assert.strictEqual(
    isMemoryKeeperShapedBody({ ...KEEPER_BODY, tools: [fn('log_diary'), fn('set_memory'), fn('delete_memory')] }),
    true);
});

test('names are matched case-insensitively', () => {
  assert.strictEqual(
    isMemoryKeeperShapedBody({ ...KEEPER_BODY, tools: [fn('Set_Memory'), fn('LOG_DIARY')] }),
    true);
});

/* ── THE FALSE-POSITIVE WALL ──────────────────────────────────────────────
 * Everything below MUST keep its style reminder. A carve-out that swallows a
 * persona turn would silently un-steer the whole family, which is a far worse
 * bug than the one being fixed. */

test('an ordinary Kiana turn is NOT the keeper', () => {
  assert.strictEqual(isMemoryKeeperShapedBody({
    model: 'z-ai/glm-5.3-flash',
    tools: ['flux', 'kade_phone_call', 'kade_notify', 'kade_memory_search', 'kade_games'].map(fn),
    messages: [{ role: 'system', content: 'you are Kiana' }, { role: 'user', content: 'hey' }],
  }), false);
});

test('kade_memory_search is the AGENT-facing tool and must not trip it', () => {
  assert.strictEqual(isMemoryKeeperShapedBody({ tools: [fn('kade_memory_search')] }), false);
});

test('an agent that also carries a keeper-named tool keeps its reminder', () => {
  assert.strictEqual(
    isMemoryKeeperShapedBody({ tools: [fn('set_memory'), fn('flux'), fn('kade_games')] }),
    false);
});

test('log_diary ALONE is not enough — set_memory is the anchor', () => {
  assert.strictEqual(isMemoryKeeperShapedBody({ tools: [fn('log_diary')] }), false);
  assert.strictEqual(isMemoryKeeperShapedBody({ tools: [fn('delete_memory')] }), false);
});

test('a toolless body is never the keeper (that is the title lane)', () => {
  assert.strictEqual(isMemoryKeeperShapedBody({ tools: [] }), false);
  assert.strictEqual(isMemoryKeeperShapedBody({}), false);
  assert.strictEqual(isMemoryKeeperShapedBody(null), false);
});

test('a person TYPING the tool names cannot trip it — detection is the toolbelt, not prose', () => {
  assert.strictEqual(isMemoryKeeperShapedBody({
    tools: ['flux', 'kade_notify'].map(fn),
    messages: [{ role: 'user', content: 'what does set_memory and log_diary do? explain delete_memory' }],
  }), false);
});

test('malformed tool entries do not throw', () => {
  assert.strictEqual(isMemoryKeeperShapedBody({ tools: [null, undefined, {}, { function: {} }] }), false);
});

test('the bare {name} tool shape is understood too', () => {
  assert.strictEqual(
    isMemoryKeeperShapedBody({ tools: [{ name: 'set_memory' }, { name: 'log_diary' }] }),
    true);
});
