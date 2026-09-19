const test = require('node:test');
const assert = require('node:assert/strict');
const { isDeepseekModel, deepseekProviderPrefs, adaptForDeepseek } = require('./deepseek.js');
const { isReasoningModel, thinkTierFor, adaptForGlm } = require('./modelbudget.js');

test('deepseek turns are pinned to US zero-retention hosts, cheapest first, fallback inside the list only', () => {
  const out = adaptForDeepseek({ model: 'deepseek/deepseek-v4.1-flash', messages: [] }, {});
  assert.deepEqual(out.provider.only, ['DeepInfra', 'Fireworks', 'Together', 'BaseTen', 'Parasail']);
  assert.deepEqual(out.provider.order, out.provider.only);
  assert.equal(out.provider.zdr, true);
  assert.equal(out.provider.data_collection, 'deny');
  assert.equal(out.provider.allow_fallbacks, true);
  for (const host of ['Baidu', 'Alibaba', 'StreamLake', 'DeepSeek']) assert.ok(!out.provider.only.includes(host));
});

test('an upstream order is kept but can never widen the allow-list or drop retention', () => {
  const out = adaptForDeepseek({ model: 'deepseek/deepseek-v4.1-flash', provider: { order: ['Fireworks'], only: ['Baidu'], zdr: false } }, {});
  assert.deepEqual(out.provider.order, ['Fireworks']);
  assert.ok(!out.provider.only.includes('Baidu'));
  assert.equal(out.provider.zdr, true);
});

test('other models and the kill switch are untouched', () => {
  const grok = { model: 'x-ai/grok-4.20' };
  assert.equal(adaptForDeepseek(grok, {}), grok);
  const body = { model: 'deepseek/deepseek-v4.1-flash' };
  assert.equal(adaptForDeepseek(body, { KADE_DEEPSEEK_PIN: '0' }), body);
  assert.equal(deepseekProviderPrefs({ KADE_DEEPSEEK_PROVIDERS: ' ' }), null);
  assert.equal(isDeepseekModel('moonshotai/kimi-k3'), false);
});

test('deepseek is a reasoning model to auto-think and gets room to think and still speak', () => {
  assert.equal(isReasoningModel('deepseek/deepseek-v4.1-flash'), true);
  assert.equal(thinkTierFor({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'none', enabled: false } }), false);
  assert.equal(thinkTierFor({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'low' } }), 'think');
  assert.equal(thinkTierFor({ model: 'deepseek/deepseek-v4.1-flash', reasoning: { effort: 'high' } }), 'deep');
  assert.ok(adaptForGlm({ model: 'deepseek/deepseek-v4.1-flash', max_tokens: 900, reasoning: { effort: 'high' } }).max_tokens > 900);
});
