'use strict';
/**
 * xai.js — provider pinning for x-ai/* models on OpenRouter (Sep 5 2026, Part 131).
 *
 * Every xAI model on OpenRouter is served by ONE provider (xAI) under FOUR
 * endpoints that are two independent flags, not four servers:
 *
 *   xai              base price        keeps prompts
 *   xai/zdr          base price        zero data retention
 *   xai/priority     EXACTLY 2x        keeps prompts
 *   xai/zdr/priority EXACTLY 2x        zero data retention
 *
 * Read live off /api/v1/models/x-ai/grok-4.20/endpoints on Sep 5 2026:
 * 1.25/2.50/0.20-cached vs 2.50/5.00/0.40-cached. ZDR costs nothing, and this
 * platform carries therapy transcripts, med lists and a child's seat — so the
 * pin is {zdr:true, sort:'price'}: OpenRouter's zdr flag is a hard filter to
 * the two ZDR endpoints, and price sort picks the base one. Fallbacks stay
 * allowed INSIDE that filter (the zdr/priority endpoint), so an xai/zdr blip
 * costs one 2x turn instead of a dead reply. Proved before shipping: a
 * grok-4.20 turn with this exact provider object billed $0.0028 warm — the
 * base tier's number, not priority's.
 *
 * Kill switch: KADE_XAI_ZDR=0 leaves x-ai bodies untouched (whatever the
 * fork sent, which today is nothing — OpenRouter's default routing, which on
 * Sep 5 sorted onto the base endpoint anyway but is not a promise).
 * Extra knobs, JSON, merged under the pin: KADE_XAI_PROVIDER='{"order":[...]}'.
 */
const XAI_MODEL_RE = /^x-ai\//i;

function isXaiModel(model) {
  return XAI_MODEL_RE.test(String(model || ''));
}

function xaiProviderPrefs(env = process.env) {
  if (env.KADE_XAI_ZDR === '0') return null;
  let extra = {};
  if (env.KADE_XAI_PROVIDER) {
    try { extra = JSON.parse(env.KADE_XAI_PROVIDER) || {}; } catch { extra = {}; }
  }
  // The pin wins over anything the caller or the env tried to set on these two.
  return { ...extra, zdr: true, sort: 'price' };
}

function adaptForXai(body, env = process.env) {
  if (!body || !isXaiModel(body.model)) return body;
  const prefs = xaiProviderPrefs(env);
  if (!prefs) return body;
  return { ...body, provider: prefs };
}

module.exports = { XAI_MODEL_RE, isXaiModel, xaiProviderPrefs, adaptForXai };
