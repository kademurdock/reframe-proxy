'use strict';
/*
 * deepseek.js — provider pinning for deepseek/* models on OpenRouter (Sep 19 2026, Part 213).
 *
 * Kade moved the fleet from x-ai/grok-4.20 to deepseek/deepseek-v4.1-flash as a
 * public trial: a tenth of the cost per turn, and Grok's redundant searches did
 * not reproduce on it. Unlike xAI, DeepSeek is served by twenty-odd providers,
 * and the cheapest are Chinese hosts (Baidu, Alibaba, StreamLake, DeepSeek).
 * This platform carries therapy transcripts, medication lists and a child's
 * seat, so the pin is a hard allow-list of US hosts that OpenRouter lists as
 * zero-data-retention for this model, tried cheapest first, with fallback
 * allowed only INSIDE that list. Read live off /api/v1/endpoints/zdr on
 * Sep 19 2026: DeepInfra 0.14/0.42, Fireworks 0.22/0.66, Together 0.30/1.20,
 * BaseTen 0.30/1.20, Parasail 0.30/1.20.
 *
 * Kill switch: KADE_DEEPSEEK_PIN=0 leaves deepseek bodies untouched.
 * KADE_DEEPSEEK_PROVIDERS overrides the list (comma separated, in order).
 */
const DEEPSEEK_MODEL_RE = /^deepseek\//i;
function isDeepseekModel(model) {
  return DEEPSEEK_MODEL_RE.test(String(model || ''));
}

function deepseekProviderPrefs(env = process.env) {
  if (String(env.KADE_DEEPSEEK_PIN ?? '1') === '0') return null;
  const only = String(env.KADE_DEEPSEEK_PROVIDERS ?? 'DeepInfra,Fireworks,Together,BaseTen,Parasail')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!only.length) return null;
  return { only, order: only, allow_fallbacks: true, zdr: true, data_collection: 'deny' };
}

function adaptForDeepseek(body, env = process.env) {
  if (!body || !isDeepseekModel(body.model)) return body;
  const prefs = deepseekProviderPrefs(env);
  if (!prefs) return body;
  // Never override an order someone set deliberately upstream; the allow-list
  // and the retention rule still apply to it.
  const existing = body.provider || {};
  return { ...body, provider: { ...prefs, ...existing, only: prefs.only, zdr: true, data_collection: 'deny' } };
}

module.exports = { DEEPSEEK_MODEL_RE, isDeepseekModel, deepseekProviderPrefs, adaptForDeepseek };
