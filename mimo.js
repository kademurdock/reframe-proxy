'use strict';

const isMimoModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-(?:pro|flash)$/i.test(String(model || ''));
const isMimoProModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-pro$/i.test(String(model || ''));

/* Oct 16 2026 speed test, direct to OpenRouter, same price on every machine.
 * Thinking OFF: DeepInfra's first word came in 0.7 s warm / 2.1 s cold on a
 * 22k-token prompt; Xiaomi took 5 s warm / 16 s cold. Output speed was about
 * the same (15-30 tokens a second on both). Thinking ON: DeepInfra stalled
 * (one 47 s gap), so thinking turns keep Xiaomi first. Both lists fall back.
 * Tune: KADE_MIMO_PROVIDER_ORDER / KADE_MIMO_THINK_PROVIDER_ORDER (comma lists). */
const orderFrom = (name, fallback) =>
  String(process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
const PRO_ORDER_INSTANT = orderFrom('KADE_MIMO_PROVIDER_ORDER', 'DeepInfra,Xiaomi');
const PRO_ORDER_THINKING = orderFrom('KADE_MIMO_THINK_PROVIDER_ORDER', 'Xiaomi,DeepInfra');

function withMimoProvider(body, thinking = false) {
  if (!isMimoModel(body?.model) || body.provider?.order) return body;
  const order = !isMimoProModel(body.model) ? ['Xiaomi'] : thinking ? PRO_ORDER_THINKING : PRO_ORDER_INSTANT;
  if (!order.length) return body;
  return {
    ...body,
    provider: { ...body.provider, order, allow_fallbacks: true },
  };
}

function adaptForMimo(body) {
  if (!isMimoModel(body?.model)) return body;
  const reasoning = { ...(body.reasoning || {}) };
  if (!reasoning.effort && typeof body.reasoning_effort === 'string') reasoning.effort = body.reasoning_effort;
  const effort = typeof reasoning.effort === 'string' ? reasoning.effort.toLowerCase() : '';
  const enabled = effort === 'none' || reasoning.enabled === false
    ? false
    : reasoning.enabled === true || ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
  const next = {
    ...body,
    reasoning: { ...reasoning, ...(enabled ? {} : { effort: 'none' }), enabled },
  };
  delete next.reasoning_effort;
  if (!enabled) return withMimoProvider(next, false);
  // Xiaomi's thinking mode fixes its sampling; inherited character sliders are unsupported.
  delete next.temperature;
  delete next.top_p;
  const ceiling = Number(body.max_tokens ?? body.max_completion_tokens);
  const floor = ['high', 'xhigh', 'max'].includes(effort) ? 32000 : 16000;
  if (!Number.isFinite(ceiling) || ceiling < floor) {
    delete next.max_completion_tokens;
    next.max_tokens = floor;
  }
  return withMimoProvider(next, true);
}

module.exports = { isMimoModel, withMimoProvider, adaptForMimo };
