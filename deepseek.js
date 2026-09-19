'use strict';
/*
 * deepseek.js — provider pinning for deepseek/* models on OpenRouter (Sep 19 2026, Part 213).
 *
 * Kade moved the fleet from x-ai/grok-4.20 to deepseek/deepseek-v4.1-flash as a
 * public trial: a tenth of the cost per turn, and Grok's redundant searches did
 * not reproduce on it. Unlike xAI, DeepSeek is served by twenty-odd providers,
 * and the cheapest are Chinese hosts (Baidu, Alibaba, StreamLake, DeepSeek).
 * This platform carries therapy transcripts, medication lists and a child's
 * seat, so every deepseek body is held to zero-data-retention endpoints. It
 * began (Part 213) as a US-only allow-list; Part 214 made it retention-only at
 * her direction. Read live off /api/v1/endpoints/zdr on Sep 19 2026: about
 * fifteen zero-retention hosts serve v4.1-flash, Morph 0.135/0.54 and
 * DeepInfra 0.14/0.42 cheapest.
 *
 * Kill switch: KADE_DEEPSEEK_PIN=0 leaves deepseek bodies untouched.
 * KADE_DEEPSEEK_PROVIDERS adds an allow-list (comma separated); empty by default.
 */
const DEEPSEEK_MODEL_RE = /^deepseek\//i;
function isDeepseekModel(model) {
  return DEEPSEEK_MODEL_RE.test(String(model || ''));
}

function deepseekProviderPrefs(env = process.env) {
  if (String(env.KADE_DEEPSEEK_PIN ?? '1') === '0') return null;
  /* Part 214 (Sep 19 2026), her word: "I don't see why it matters whether my
   * info stays in the US or not. I'm slightly more worried about 0dr, less
   * worried about who has my data." So the rule is retention, not geography:
   * zdr is OpenRouter's hard filter to endpoints that keep no copy, price sort
   * picks the cheapest of them, and fallback stays inside that filter. The
   * same shape as xai.js. An allow-list is still available by env for the day
   * she wants one; it is empty by default. */
  const prefs = { zdr: true, data_collection: 'deny', sort: 'price', allow_fallbacks: true };
  const only = String(env.KADE_DEEPSEEK_PROVIDERS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return only.length ? { ...prefs, only } : prefs;
}

function adaptForDeepseek(body, env = process.env) {
  if (!body || !isDeepseekModel(body.model)) return body;
  const prefs = deepseekProviderPrefs(env);
  if (!prefs) return body;
  // An upstream order or allow-list is kept; the retention rule is not negotiable.
  const existing = body.provider || {};
  const next = { ...prefs, ...existing, zdr: true, data_collection: 'deny' };
  if (existing.order) delete next.sort; // OpenRouter rejects sort together with order
  return { ...body, provider: next };
}

module.exports = { DEEPSEEK_MODEL_RE, isDeepseekModel, deepseekProviderPrefs, adaptForDeepseek };
