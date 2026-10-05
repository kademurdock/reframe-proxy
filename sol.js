'use strict';

const SOL_MODEL_RE = /^(?:openai\/)?gpt-6\.1-sol(?:-\d{8})?$/i;

function isSolModel(model) {
  return SOL_MODEL_RE.test(String(model || ''));
}

function solEffortFor(body) {
  const requested = body.reasoning?.effort || body.reasoning_effort;
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(requested) ? requested : 'low';
  return body.kade_think_max_effort === 'medium' && ['high', 'xhigh', 'max'].includes(effort)
    ? 'medium' : effort;
}

function adaptForSol(body) {
  if (!body) return body;
  if (!isSolModel(body.model)) {
    if (!Object.hasOwn(body, 'kade_think_max_effort')) return body;
    const cleaned = { ...body };
    delete cleaned.kade_think_max_effort;
    return cleaned;
  }
  const next = { ...body };
  const reasoning = { ...(body.reasoning || {}) };
  reasoning.effort = solEffortFor(body);
  delete reasoning.enabled;
  delete reasoning.max_tokens;
  next.reasoning = reasoning;
  delete next.kade_think_max_effort;
  for (const key of ['reasoning_effort', 'include_reasoning', 'temperature', 'top_p', 'top_k',
    'logprobs', 'top_logprobs', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'stop']) {
    delete next[key];
  }
  const limit = Number(body.max_completion_tokens ?? body.max_tokens);
  if (Number.isFinite(limit) && limit > 0) next.max_completion_tokens = Math.min(limit, 128000);
  delete next.max_tokens;
  next.provider = {
    order: ['azure', 'azure/eu', 'azure/us', 'openai'],
    allow_fallbacks: true,
    ...(body.provider || {}),
    zdr: true,
    data_collection: 'deny',
  };
  if (next.provider.order) delete next.provider.sort;
  return next;
}

module.exports = { SOL_MODEL_RE, isSolModel, solEffortFor, adaptForSol };
