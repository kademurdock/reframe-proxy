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
 * Part 215 (Sep 19 2026): price sort was the wait. Kade: "I can't stand the
 * wait time as it is right now... if we need to spend more to get better
 * speeds, so be it." The same Kiana turn timed on every zero-retention host,
 * twice: the cheapest three that price sort kept choosing write 10-60 tokens a
 * second (Morph 10-16, Relace 14-19, DeepInfra 31-62), so a deep think of a
 * thousand tokens was 77-97 s before the first word and a long one was
 * minutes. Together, Parasail, Modal and Makora write 190-290 a second: first
 * word in 1-4 s with thinking on, faster than Grok 4.20 measured the same
 * hour (10.5 s). They charge 0.30/1.20 against 0.14/0.42, still under half
 * of Grok per turn. So: fast hosts first, in order (one steady first host
 * also keeps the persona prompt cached), the slow ones ignored, and fallback
 * stays inside zero retention.
 *
 * Kill switch: KADE_DEEPSEEK_PIN=0 leaves deepseek bodies untouched.
 * KADE_DEEPSEEK_PROVIDERS adds an allow-list (comma separated); empty by default.
 * KADE_DEEPSEEK_ORDER / KADE_DEEPSEEK_IGNORE replace the lists below (comma
 * separated); KADE_DEEPSEEK_ORDER set to an empty string returns to price sort.
 */
const DEEPSEEK_FAST_ORDER = ['together', 'parasail', 'modal', 'makora'];
const DEEPSEEK_SLOW_IGNORE = ['morph', 'relace', 'deepinfra', 'digitalocean'];
function envList(value, fallback) {
  if (value === undefined || value === null) return fallback;
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
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
  const order = envList(env.KADE_DEEPSEEK_ORDER, DEEPSEEK_FAST_ORDER);
  const ignore = envList(env.KADE_DEEPSEEK_IGNORE, DEEPSEEK_SLOW_IGNORE);
  const prefs = order.length
    ? { zdr: true, data_collection: 'deny', order, ...(ignore.length ? { ignore } : {}), allow_fallbacks: true }
    : { zdr: true, data_collection: 'deny', sort: 'price', allow_fallbacks: true };
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
  if (next.order) delete next.sort; // OpenRouter rejects sort together with order
  return { ...body, provider: next };
}

module.exports = { DEEPSEEK_MODEL_RE, isDeepseekModel, deepseekProviderPrefs, adaptForDeepseek };
