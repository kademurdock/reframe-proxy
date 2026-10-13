'use strict';

const isMimoModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-pro$/i.test(String(model || ''));

function withMimoProvider(body) {
  if (!isMimoModel(body?.model) || body.provider?.order) return body;
  return {
    ...body,
    provider: { ...body.provider, order: ['Xiaomi'], allow_fallbacks: true },
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
  if (!enabled) return withMimoProvider(next);
  const ceiling = Number(body.max_tokens ?? body.max_completion_tokens);
  const floor = ['high', 'xhigh', 'max'].includes(effort) ? 32000 : 16000;
  if (!Number.isFinite(ceiling) || ceiling < floor) {
    delete next.max_completion_tokens;
    next.max_tokens = floor;
  }
  return withMimoProvider(next);
}

module.exports = { isMimoModel, withMimoProvider, adaptForMimo };
