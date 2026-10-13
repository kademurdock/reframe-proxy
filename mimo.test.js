'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isMimoModel, withMimoProvider, adaptForMimo } = require('./mimo');
const { isReasoningModel, isWordlessTurn, rescueWordlessTurn } = require('./modelbudget');

test('the fleet model participates in automatic reasoning and empty-answer recovery', () => {
  assert.equal(isMimoModel('xiaomi/mimo-v2.6-pro'), true);
  assert.equal(isMimoModel('mimo-v2.6-pro'), true);
  assert.equal(isMimoModel('xiaomi/mimo-v2.6-pro-ultraspeed'), false);
  assert.equal(isReasoningModel('xiaomi/mimo-v2.6-pro'), true);
  assert.equal(isWordlessTurn({ model: 'xiaomi/mimo-v2.6-pro', finishReason: 'length', contentLength: 0 }), true);
});

test('provider selection preserves caller choices and privacy filters', () => {
  const body = { model: 'xiaomi/mimo-v2.6-pro', provider: { ignore: ['NovitaAI'], data_collection: 'deny' } };
  const next = withMimoProvider(body);
  assert.deepEqual(next.provider, { ...body.provider, order: ['Xiaomi'], allow_fallbacks: true });
  assert.deepEqual(body.provider, { ignore: ['NovitaAI'], data_collection: 'deny' });
  const chosen = { ...body, provider: { ...body.provider, order: ['GMICloud'] } };
  assert.equal(withMimoProvider(chosen), chosen);
  const other = { model: 'z-ai/glm-5.3-flash' };
  assert.equal(withMimoProvider(other), other);
  assert.equal(adaptForMimo(other), other);
});

test('ordinary and phone turns disable reasoning without increasing the output cap', () => {
  const plain = adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', max_tokens: 600 });
  assert.equal(plain.reasoning.enabled, false);
  assert.equal(plain.reasoning.effort, 'none');
  assert.equal(plain.max_tokens, 600);
  const phone = adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', max_tokens: 600, reasoning: { effort: 'none', enabled: true } });
  assert.equal(phone.reasoning.enabled, false);
  assert.equal(phone.max_tokens, 600);
  assert.equal(plain.provider.order[0], 'Xiaomi');
  const legacy = adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', reasoning_effort: 'none', max_tokens: 600 });
  assert.equal(legacy.reasoning.enabled, false);
  assert.equal(Object.hasOwn(legacy, 'reasoning_effort'), false);
});

test('requested thinking retains reasoning visibility and has room for a visible answer', () => {
  const body = { model: 'xiaomi/mimo-v2.6-pro', max_tokens: 600, temperature: 0.85, top_p: 0.95, reasoning: { effort: 'high', enabled: true, exclude: false } };
  const next = adaptForMimo(body);
  assert.equal(next.reasoning.enabled, true);
  assert.equal(next.reasoning.exclude, false);
  assert.equal(next.max_tokens, 32000);
  assert.equal(body.max_tokens, 600);
  assert.equal(Object.hasOwn(next, 'temperature'), false);
  assert.equal(Object.hasOwn(next, 'top_p'), false);
  assert.deepEqual(adaptForMimo(next), next);
  assert.equal(adaptForMimo({ ...body, max_tokens: 40000 }).max_tokens, 40000);
});

test('the same-model empty-answer rescue explicitly disables thinking', async () => {
  let sent;
  const result = await rescueWordlessTurn({
    upstreamBody: { model: 'xiaomi/mimo-v2.6-pro', reasoning: { effort: 'high' } },
    reqId: 'synthetic',
    callOpenRouter: async (body) => {
      sent = body;
      return { choices: [{ message: { content: 'Recovered.' }, finish_reason: 'stop' }] };
    },
  });
  assert.equal(sent.reasoning.effort, 'none');
  assert.equal(sent.reasoning.enabled, false);
  assert.equal(result.text, 'Recovered.');
});
