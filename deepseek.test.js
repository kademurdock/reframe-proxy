const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeepseekModel, deepseekProviderPrefs, adaptForDeepseek } = require('./deepseek.js');
const { isReasoningModel, thinkTierFor, adaptForGlm } = require('./modelbudget.js');

test('deepseek turns are held to zero-retention endpoints, fast hosts first, slow ones ignored', () => {
  const out = adaptForDeepseek({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }, {});
  assert.deepEqual(out.provider, {
    zdr: true,
    data_collection: 'deny',
    order: ['together', 'parasail', 'modal', 'makora'],
    ignore: ['morph', 'relace', 'deepinfra', 'digitalocean'],
    allow_fallbacks: true,
  });
});

test('the host lists are env-tunable and an empty order returns to price sort', () => {
  const tuned = deepseekProviderPrefs({ KADE_DEEPSEEK_ORDER: 'modal, together', KADE_DEEPSEEK_IGNORE: '' });
  assert.deepEqual(tuned.order, ['modal', 'together']);
  assert.equal(tuned.ignore, undefined);
  assert.deepEqual(deepseekProviderPrefs({ KADE_DEEPSEEK_ORDER: '' }), { zdr: true, data_collection: 'deny', sort: 'price', allow_fallbacks: true });
});

test('an upstream order or an env allow-list is kept but can never drop retention', () => {
  const out = adaptForDeepseek({ model: 'deepseek/deepseek-v4.1-flash', provider: { order: ['Fireworks'], zdr: false, data_collection: 'allow' } }, {});
  assert.deepEqual(out.provider.order, ['Fireworks']);
  assert.equal(out.provider.sort, undefined, 'sort and order cannot ride together');
  assert.equal(out.provider.zdr, true);
  assert.equal(out.provider.data_collection, 'deny');
  assert.deepEqual(adaptForDeepseek({ model: 'deepseek/deepseek-v4-flash' }, { KADE_DEEPSEEK_PROVIDERS: 'DeepInfra, Together' }).provider.only, ['DeepInfra', 'Together']);
});

test('other models and the kill switch are untouched', () => {
  const grok = { model: 'x-ai/grok-4.20' };
  assert.equal(adaptForDeepseek(grok, {}), grok);
  const body = { model: 'deepseek/deepseek-v4.1-flash' };
  assert.equal(adaptForDeepseek(body, { KADE_DEEPSEEK_PIN: '0' }), body);
  assert.equal(deepseekProviderPrefs({ KADE_DEEPSEEK_PROVIDERS: ' ' }).only, undefined);
  assert.equal(isDeepseekModel('moonshotai/kimi-k3'), false);
});

test('deepseek is a reasoning model to auto-think and gets room to think and still speak', () => {
  assert.equal(isReasoningModel('deepseek/deepseek-v4.1-flash'), true);
  assert.equal(thinkTierFor({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'none', enabled: false } }), false);
  assert.equal(thinkTierFor({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'low' } }), 'think');
  assert.equal(thinkTierFor({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'high' } }), 'deep');
  assert.ok(adaptForGlm({ model: 'deepseek/deepseek-v4.1-flash', max_tokens: 900, reasoning: { effort: 'high' } }).max_tokens > 900);
});
