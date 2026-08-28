'use strict';
/**
 * The two live shapes from Aug 23 2026 are the first tests, verbatim off the
 * proxy's own log lines, because a fix that cannot reproduce the bug it claims
 * to fix is a guess.
 *
 *   req 9vipwj (Forge, 23:19:14Z)
 *     read loop ended at 259223ms, toolMode=false, contentAccum.length=0,
 *     reasoningAccum.length=34073, finishReason=length
 *     upstream usage: prompt=41538 cached=29888 completion=8000
 *
 *   req v6w0g2 (Amber A, a family seat, 23:31:48Z)
 *     auto-think classifier -> quick
 *     handleStreaming start, reasoning={"effort":"none","exclude":false}
 *     read loop ended at 64659ms, toolMode=false, contentAccum.length=0,
 *     reasoningAccum.length=17523, finishReason=length
 *     upstream usage: prompt=33626 cached=0 completion=4000
 *     content-turn response sent at 64659ms, finalLength=0
 */
const test = require('node:test');
const assert = require('node:assert');
const M = require('./modelbudget.js');

/* ════════════════════════════════════════════════════════════════════════
 * THE DISARMED PREDICATE — the bug underneath both outages
 * ════════════════════════════════════════════════════════════════════════ */

test('THE OUTAGE, REPRODUCED: the bare Z.AI name must still read as a reasoning model', () => {
  // adaptForZai rewrites 'z-ai/glm-5.3' -> 'glm-5.3' before the guard ever
  // sees it. The old regex was anchored /^z-ai\/glm/i and answered false here,
  // which is precisely how the guard went dark fleet-wide on Aug 21.
  assert.strictEqual(M.isReasoningModel('glm-5.3'), true, 'bare name — the one the guard actually receives');
  assert.strictEqual(M.isReasoningModel('z-ai/glm-5.3'), true, 'prefixed name — the one it used to receive');
});

test('every spelling the platform can produce for one model agrees', () => {
  for (const pair of [['z-ai/glm-5.3', 'glm-5.3'], ['z-ai/glm-4.5-air', 'glm-4.5-air']]) {
    const [prefixed, bare] = pair;
    assert.strictEqual(M.isGlmModel(prefixed), M.isGlmModel(bare), `${prefixed} vs ${bare}`);
    assert.strictEqual(M.alwaysThinks(prefixed), M.alwaysThinks(bare), `${prefixed} vs ${bare}`);
  }
});

test('the widened regex did not start swallowing models that are not GLM', () => {
  for (const m of ['openai/gpt-4o', 'anthropic/claude-3', 'glimmer/x', 'deepseek/deepseek-v4-flash', '', null]) {
    assert.strictEqual(M.isGlmModel(m), false, String(m));
  }
});

/* ════════════════════════════════════════════════════════════════════════
 * AMBER A — the turn that was declared not-thinking and then made to think
 * ════════════════════════════════════════════════════════════════════════ */

const AMBER_A_TURN = {
  model: 'z-ai/glm-5.3',
  reasoning: { effort: 'none', exclude: false },
  max_tokens: 4000,
};

test("AMBER A'S BUG, REPRODUCED: effort:'none' on glm-5.3 is a request, not a guarantee", () => {
  // adaptForZai sets thinking:{type:'enabled'} for glm-5.3 no matter what the
  // caller asked, because Z.AI cannot disable it. The budget path has to agree.
  assert.strictEqual(M.alwaysThinks(AMBER_A_TURN.model), true);
  assert.strictEqual(M.thinkTierFor(AMBER_A_TURN), 'think', 'the old code returned false here and skipped the floor entirely');
});

test('AMBER A: she gets a floor now — 4,000 was the whole reason she got silence', () => {
  const out = M.adaptForGlm(AMBER_A_TURN);
  assert.strictEqual(out.max_tokens, M.GLM_THINK_MIN_TOKENS);
  assert.ok(out.max_tokens > 4000, 'must exceed the budget her reasoning actually consumed');
  // Her reasoning was 17,523 chars ~= 4,100 tokens. The floor has to clear that
  // AND leave room for a reply, or this is theatre.
  assert.ok(out.max_tokens - 4100 > 2000, 'must leave real room for words after the thinking');
});

/* ════════════════════════════════════════════════════════════════════════
 * FORGE — the deep turn with two tokens of headroom
 * ════════════════════════════════════════════════════════════════════════ */

const FORGE_TURN = {
  model: 'z-ai/glm-5.3',
  reasoning: { effort: 'high', exclude: false },
  max_tokens: 4096,
};

test("FORGE'S BUG, REPRODUCED: 7,998 reasoning tokens against an 8,000 cap", () => {
  assert.strictEqual(M.thinkTierFor(FORGE_TURN), 'deep');
  const out = M.adaptForGlm(FORGE_TURN);
  assert.strictEqual(out.max_tokens, M.GLM_DEEP_MIN_TOKENS);
  assert.ok(out.max_tokens >= 8000 * 4, 'a developer agent should not be rationed — her call, Aug 24');
});

test('the fast lane is untouched: a non-thinking model keeps its small budget', () => {
  const instant = { model: 'openai/gpt-4o', reasoning: { effort: 'none' }, max_tokens: 900 };
  assert.strictEqual(M.adaptForGlm(instant).max_tokens, 900);
});

test('the floor only ever raises — never lowers a budget someone set deliberately', () => {
  const generous = { model: 'z-ai/glm-5.3', reasoning: { effort: 'high' }, max_tokens: 200000 };
  assert.strictEqual(M.adaptForGlm(generous).max_tokens, 200000);
});

test('adaptForGlm is idempotent — it runs inside a nest of adapters', () => {
  const once = M.adaptForGlm(FORGE_TURN);
  const twice = M.adaptForGlm(once);
  assert.deepStrictEqual(twice, once);
});

/* ════════════════════════════════════════════════════════════════════════
 * THE LAST LINE OF DEFENCE
 * ════════════════════════════════════════════════════════════════════════ */

test('THE GUARD FIRES ON BOTH LOGGED SHAPES — on the bare name that disarmed it', () => {
  assert.strictEqual(M.isWordlessTurn({ model: 'glm-5.3', finishReason: 'length', contentLength: 0 }), true, 'Forge, req 9vipwj');
  assert.strictEqual(M.isWordlessTurn({ model: 'glm-5.3', finishReason: 'length', contentLength: 0 }), true, 'Amber A, req v6w0g2');
});

test('the guard no longer requires visible reasoning to rescue a silent turn', () => {
  // The old condition was `reasoningAccum.length > 0`. A turn that burns its
  // budget with reasoning EXCLUDED from the stream is just as silent to the
  // person, and used to sail straight through.
  assert.strictEqual(M.isWordlessTurn({ model: 'glm-5.3', finishReason: 'length', contentLength: 0 }), true);
});

test('the guard leaves healthy turns alone', () => {
  assert.strictEqual(M.isWordlessTurn({ model: 'glm-5.3', finishReason: 'stop', contentLength: 1538 }), false, 'normal reply');
  assert.strictEqual(M.isWordlessTurn({ model: 'glm-5.3', finishReason: 'length', contentLength: 11315 }), false, 'truncated but has words — a different net catches this');
  assert.strictEqual(M.isWordlessTurn({ model: 'openai/gpt-4o', finishReason: 'length', contentLength: 0 }), false, 'not a reasoning model');
});

test('a tool-call round with no prose is NOT a wordless turn', () => {
  // req 4dhr8h: contentAccum 0, finishReason 'stop', toolMode true. Normal.
  // Only finish=length means the budget ran out.
  assert.strictEqual(M.isWordlessTurn({ model: 'glm-5.3', finishReason: 'stop', contentLength: 0 }), false);
});

/* ════════════════════════════════════════════════════════════════════════
 * THE RESCUE, EXTRACTED (Aug 28 2026) — one re-ask, three lanes
 * ════════════════════════════════════════════════════════════════════════ */

const wordlessBody = {
  model: 'glm-5.3',
  stream: true,
  stream_options: { include_usage: true },
  reasoning: { effort: 'high' },
  include_reasoning: true,
  reasoning_effort: 'high',
  messages: [{ role: 'user', content: 'hi' }],
};

test('rescue lands: content comes back with its finish reason', async () => {
  const seen = [];
  const out = await M.rescueWordlessTurn({
    upstreamBody: wordlessBody,
    reqId: 't1',
    callOpenRouter: async (b) => {
      seen.push(b);
      return { choices: [{ message: { content: 'the plain answer' }, finish_reason: 'stop' }] };
    },
  });
  assert.deepStrictEqual(out, { text: 'the plain answer', finishReason: 'stop' });
  // The fallback body must be buffered and reasoning-free — the failure being
  // cured is the reasoning spend itself.
  assert.strictEqual(seen[0].stream, false);
  assert.strictEqual('stream_options' in seen[0], false);
  assert.strictEqual('reasoning' in seen[0], false);
  assert.strictEqual('include_reasoning' in seen[0], false);
  assert.strictEqual('reasoning_effort' in seen[0], false);
});

test('rescue fail-soft: empty content yields null, never an empty string served as an answer', async () => {
  const out = await M.rescueWordlessTurn({
    upstreamBody: wordlessBody,
    reqId: 't2',
    callOpenRouter: async () => ({ choices: [{ message: { content: '   ' }, finish_reason: 'stop' }] }),
  });
  assert.strictEqual(out, null);
});

test('rescue fail-soft: a throwing re-ask yields null and no throw escapes', async () => {
  const out = await M.rescueWordlessTurn({
    upstreamBody: wordlessBody,
    reqId: 't3',
    callOpenRouter: async () => { throw new Error('provider died'); },
  });
  assert.strictEqual(out, null);
});

test("the phone window is real: a rescue that outlives timeoutMs yields null (dead air capped, caller's turn proceeds)", async () => {
  const t0 = Date.now();
  const out = await M.rescueWordlessTurn({
    upstreamBody: wordlessBody,
    reqId: 't4',
    timeoutMs: 60,
    callOpenRouter: () => new Promise(() => {}), // never resolves — the exact hang the window exists for
  });
  assert.strictEqual(out, null);
  assert.ok(Date.now() - t0 < 2000, 'the window must actually cut the wait');
});

/* ── Source-level guard (spec test 7): the two return sites must keep their
 * checks. A refactor that moves the returns cannot silently drop the guard —
 * this is the same trick the Amber Lacey fix used against an upstream merge. */
const fs = require('node:fs');
const serverSrcRaw = fs.readFileSync(require.resolve('./server.js'), 'utf8');
/* ⚠️ COMMENTS STRIPPED BEFORE ANY ASSERTION. The first version of these
 * guards matched the phrase `shimFirstWrite === 0` — which also appears in
 * the COMMENT documenting the guard, so removing the actual check left the
 * test green. Caught by the red-proof (mutate, verify the mutation applied,
 * expect red — it stayed green). A source guard must read code, never prose
 * about code. */
const serverSrc = serverSrcRaw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('SOURCE GUARD: shim-live return site still asserts the byte counter and the predicate', () => {
  const shimReturn = serverSrc.indexOf("shim-live: content turn done");
  assert.ok(shimReturn > 0, 'shim finish log line must exist');
  const before = serverSrc.slice(Math.max(0, shimReturn - 3000), shimReturn);
  assert.ok(before.includes('shimFirstWrite === 0'), 'shim rescue must gate on the byte counter, asserted not inferred');
  assert.ok(before.includes('isWordlessTurn'), 'shim rescue must use the shared predicate');
  assert.ok(before.includes('rescueWordlessTurn'), 'shim rescue must call the ONE extracted rescue');
});

test('SOURCE GUARD: phone-live return site still asserts byte counter, sawDone, and the predicate', () => {
  const phoneReturn = serverSrc.indexOf('phone live-stream ended');
  assert.ok(phoneReturn > 0, 'phone finish log line must exist');
  const before = serverSrc.slice(Math.max(0, phoneReturn - 3500), phoneReturn);
  assert.ok(before.includes('phoneFirstWrite === 0'), 'phone rescue must gate on the byte counter');
  assert.ok(before.includes('!sawDone'), 'phone rescue must refuse to speak after the [DONE] went downstream');
  assert.ok(before.includes('isWordlessTurn'), 'phone rescue must use the shared predicate');
  assert.ok(before.includes('KADE_PHONE_RESCUE_MS'), 'phone rescue must carry its own tighter clock');
});

test('SOURCE GUARD: the buffered lane calls the extracted rescue and keeps NO inline copy', () => {
  assert.ok(serverSrc.includes("lane: 'buffered'"), 'buffered lane must ride the shared rescue');
  // The old inline body-building must be gone from server.js — a second copy
  // is how the last predicate got disarmed for three days.
  assert.ok(!serverSrc.includes('delete fallbackBody.reasoning'), 'no duplicated rescue body-building in server.js');
});
