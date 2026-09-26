'use strict';
/**
 * usage-cost.js — WHAT AN OPENROUTER CALL REALLY COST (Sep 26 2026, Part 295).
 *
 * Kade is putting her Google AI Studio key into OpenRouter (BYOK) so Gemini
 * bills her Google balance. On a BYOK call OpenRouter's `usage.cost` is only
 * OpenRouter's own fee (often 0 inside the free allowance), and what Google
 * charged moves to `usage.cost_details.upstream_inference_cost`. Read `cost`
 * alone and a Gemini turn costs $0: users are charged nothing and her
 * real-cost readouts go blank.
 *
 * ⚠️ BUT DO NOT JUST ADD THE TWO. The docs' "0 or null for everyone else" is
 * about the /generation lookup. On the inline usage of an ordinary (non-BYOK)
 * call, upstream_inference_cost EQUALS cost — measured on our own saved
 * responses (the Sep 25 A/B runs and the Pluto blind gate, google/gemini-2.5-
 * flash-lite among them: cost 0.0125646, is_byok false, upstream 0.0125646).
 * `cost + upstream` would double every call on the platform. The real cost is
 *   is_byok === true ? cost + upstream_inference_cost : cost
 *
 * THIS PROXY NEVER BILLS. It hands usage through to whoever called (the fork's
 * debate room, Clubhouse, parlor and game seats bill from it), so a single
 * call's usage goes back UNTOUCHED and the biller does the sum above.
 *
 * Where the proxy merges two calls into one usage (the coherence regeneration,
 * the slop rewrite and its second swing, the sensitive-image and truncation
 * retries), sumUsage used to keep only the token counts, so the cost fields
 * vanished and the fork fell back to its flat $1/M guess. It now carries the
 * cost pair too, but only when BOTH calls reported a cost: a Moonshot or Z.AI
 * direct call reports none, and half a price billed as the whole is worse
 * than the guess.
 */

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/* The real dollars behind one usage object, or null when the provider named
 * no price (Moonshot, Z.AI direct). */
function realCostOf(usage) {
  if (!usage || !isNum(usage.cost)) return null;
  const upstream = usage.is_byok === true && usage.cost_details ? usage.cost_details.upstream_inference_cost : 0;
  return usage.cost + (isNum(upstream) ? upstream : 0);
}

/* Only a BYOK call's upstream figures are money on top of `cost`. A merged
 * usage has one is_byok for both calls, so a non-BYOK side's copies (which
 * restate its `cost`) are blanked before the sum; the merged pair then reads
 * right with or without the is_byok check. */
function billedDetails(usage) {
  const d = usage.cost_details;
  if (!d || usage.is_byok === true) return d;
  const out = { ...d };
  for (const k of Object.keys(out)) if (k.startsWith('upstream_inference')) out[k] = null;
  return out;
}

function sumCostDetails(a, b) {
  if (!a && !b) return undefined;
  const out = {};
  for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
    const x = a ? a[k] : undefined;
    const y = b ? b[k] : undefined;
    out[k] = isNum(x) || isNum(y) ? (isNum(x) ? x : 0) + (isNum(y) ? y : 0) : (x ?? y ?? null);
  }
  return out;
}

function sumUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const out = {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  };
  if (isNum(a.cost) && isNum(b.cost)) {
    out.cost = a.cost + b.cost;
    if (a.is_byok != null || b.is_byok != null) out.is_byok = a.is_byok === true || b.is_byok === true;
    const details = sumCostDetails(billedDetails(a), billedDetails(b));
    if (details) out.cost_details = details;
  }
  return out;
}

/* Log suffix: the real cost, and the split when a BYOK key paid the provider.
 * Empty when the provider named no price. */
function costNote(usage) {
  const real = realCostOf(usage);
  if (real == null) return '';
  return usage.is_byok === true
    ? ` cost=$${real.toFixed(6)} (BYOK: OpenRouter fee $${usage.cost.toFixed(6)} + provider $${(real - usage.cost).toFixed(6)})`
    : ` cost=$${real.toFixed(6)}`;
}

module.exports = { realCostOf, sumUsage, costNote };
