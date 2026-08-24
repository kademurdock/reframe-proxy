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
