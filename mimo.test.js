'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { isMimoModel, withMimoProvider, adaptForMimo } = require('./mimo');
const { isReasoningModel, isWordlessTurn, rescueWordlessTurn } = require('./modelbudget');

test('the fleet model participates in automatic reasoning and empty-answer recovery', () => {
  assert.equal(isMimoModel('xiaomi/mimo-v2.6-pro'), true);
  assert.equal(isMimoModel('mimo-v2.6-pro'), true);
  assert.equal(isMimoModel('xiaomi/mimo-v2.6-flash'), true);
  assert.equal(isReasoningModel('xiaomi/mimo-v2.6-pro'), true);
  assert.equal(isWordlessTurn({ model: 'xiaomi/mimo-v2.6-pro', finishReason: 'length', contentLength: 0 }), true);
});

test('the ultraspeed slug keeps every MiMo guard but is never given a host order', () => {
  const fast = 'xiaomi/mimo-v2.6-pro-ultraspeed';
  assert.equal(isMimoModel(fast), true);
  assert.equal(isMimoModel('xiaomi/mimo-v2.6-pro-turbo'), false);
  assert.equal(isReasoningModel(fast), true);
  assert.equal(isWordlessTurn({ model: fast, finishReason: 'length', contentLength: 0 }), true);
  assert.equal(isWordlessTurn({ model: fast, finishReason: 'stop', contentLength: 0, reasoningLength: 900 }), true);
  const next = adaptForMimo({ model: fast, max_tokens: 600 });
  assert.equal(next.reasoning.enabled, false);
  assert.equal(next.reasoning.effort, 'none');
  assert.deepEqual(next.provider, { allow_fallbacks: true, zdr: true, data_collection: 'deny' });
});

test('provider selection keeps caller choices but always adds the retention rule', () => {
  const retention = { allow_fallbacks: true, zdr: true, data_collection: 'deny' };
  const body = { model: 'xiaomi/mimo-v2.6-pro', provider: { ignore: ['NovitaAI'] } };
  const next = withMimoProvider(body);
  assert.deepEqual(next.provider, { ignore: ['NovitaAI'], order: ['DeepInfra'], ...retention });
  assert.deepEqual(withMimoProvider(body, true).provider.order, ['DeepInfra']);
  assert.deepEqual(body.provider, { ignore: ['NovitaAI'] });
  const chosen = { ...body, provider: { ...body.provider, order: ['GMICloud'] } };
  assert.deepEqual(withMimoProvider(chosen).provider, { ignore: ['NovitaAI'], order: ['GMICloud'], ...retention });
  const flash = withMimoProvider({ model: 'xiaomi/mimo-v2.6-flash' });
  assert.deepEqual(flash.provider, { order: ['DeepInfra'], ...retention });
  const other = { model: 'z-ai/glm-5.3-flash' };
  assert.equal(withMimoProvider(other), other);
  assert.equal(adaptForMimo(other), other);
});

test('a caller cannot switch the retention rule off', () => {
  const sneaky = { zdr: false, data_collection: 'allow', allow_fallbacks: false, sort: 'throughput' };
  for (const model of ['xiaomi/mimo-v2.6-pro', 'xiaomi/mimo-v2.6-flash', 'xiaomi/mimo-v2.6-pro-ultraspeed']) {
    for (const reasoning of [{ effort: 'none' }, { effort: 'high', enabled: true }]) {
      const out = adaptForMimo({ model, reasoning, provider: { ...sneaky } });
      assert.equal(out.provider.zdr, true, model);
      assert.equal(out.provider.data_collection, 'deny', model);
      assert.equal(out.provider.allow_fallbacks, true, model);
    }
  }
  const ordered = withMimoProvider({ model: 'xiaomi/mimo-v2.6-pro', provider: { ...sneaky, order: ['Xiaomi'] } });
  assert.deepEqual(ordered.provider, { order: ['Xiaomi'], allow_fallbacks: true, zdr: true, data_collection: 'deny' });
  // With no order to set, a caller's sort survives and still rides inside the filter.
  const sorted = withMimoProvider({ model: 'xiaomi/mimo-v2.6-pro-ultraspeed', provider: { ...sneaky } });
  assert.deepEqual(sorted.provider, { sort: 'throughput', allow_fallbacks: true, zdr: true, data_collection: 'deny' });
});

test('the env order overrides tune the host order but never the filter', () => {
  const saved = { a: process.env.KADE_MIMO_PROVIDER_ORDER, b: process.env.KADE_MIMO_THINK_PROVIDER_ORDER };
  const path = require.resolve('./mimo');
  try {
    process.env.KADE_MIMO_PROVIDER_ORDER = 'Xiaomi, DeepInfra';
    process.env.KADE_MIMO_THINK_PROVIDER_ORDER = '';
    delete require.cache[path];
    const fresh = require('./mimo');
    const instant = fresh.adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', reasoning: { effort: 'none' } });
    assert.deepEqual(instant.provider, { order: ['Xiaomi', 'DeepInfra'], allow_fallbacks: true, zdr: true, data_collection: 'deny' });
    const thinking = fresh.adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', reasoning: { effort: 'high' } });
    assert.deepEqual(thinking.provider, { allow_fallbacks: true, zdr: true, data_collection: 'deny' });
    assert.deepEqual(fresh.adaptForMimo({ model: 'xiaomi/mimo-v2.6-flash' }).provider.order, ['DeepInfra']);
  } finally {
    for (const [key, value] of [['KADE_MIMO_PROVIDER_ORDER', saved.a], ['KADE_MIMO_THINK_PROVIDER_ORDER', saved.b]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    delete require.cache[path];
  }
});

test('ordinary and phone turns disable reasoning without increasing the output cap', () => {
  const plain = adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', max_tokens: 600 });
  assert.equal(plain.reasoning.enabled, false);
  assert.equal(plain.reasoning.effort, 'none');
  assert.equal(plain.max_tokens, 600);
  const phone = adaptForMimo({ model: 'xiaomi/mimo-v2.6-pro', max_tokens: 600, reasoning: { effort: 'none', enabled: true } });
  assert.equal(phone.reasoning.enabled, false);
  assert.equal(phone.max_tokens, 600);
  assert.equal(plain.provider.order[0], 'DeepInfra');
  assert.equal(plain.provider.zdr, true);
  const flash = adaptForMimo({ model: 'xiaomi/mimo-v2.6-flash', max_tokens: 4, reasoning_effort: 'none' });
  assert.equal(flash.reasoning.enabled, false);
  assert.equal(flash.max_tokens, 4);
  assert.equal(flash.provider.order[0], 'DeepInfra');
  assert.equal(flash.provider.zdr, true);
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
  assert.deepEqual(next.provider, { order: ['DeepInfra'], allow_fallbacks: true, zdr: true, data_collection: 'deny' });
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

test('the real auto-think classifier keeps Jev first and sends only MiMo Flash when Jev fails', async () => {
  const source = fs.readFileSync(require.resolve('./server'), 'utf8');
  const start = source.indexOf('async function classifyThinkTier(');
  const end = source.indexOf('async function maybeAutoThink(', start);
  const requests = [];
  let fail = false;
  const context = vm.createContext({
    console: { log() {} }, Date,
    jev: { enabled: () => true, thinkTier: async () => { if (fail) throw Error('offline'); return { tier: 'quick', confidence: 0.9 }; } },
    jevTierPrefetch: new Map(), JEV_THINK_TIMEOUT_MS: 100, AUTO_CLASSIFY_TIMEOUT_MS: 100,
    adaptForMimo, adaptForDeepseek: x => x, adaptForXai: x => x, adaptForGlm: x => x, adaptForKimi: x => x,
    chatCompletionsUrl: () => 'https://model.test/chat/completions', chatHeaders: () => ({}),
    fetchWithTimeout: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'deep' } }] }) };
    },
  });
  vm.runInContext(source.slice(start, end) + '\nthis.classify = classifyThinkTier;', context);
  assert.equal(await context.classify('Test question', 'a'), 'quick');
  assert.equal(requests.length, 0);
  fail = true;
  assert.equal(await context.classify('Test question', 'b'), 'deep');
  assert.equal(requests[0].model, 'xiaomi/mimo-v2.6-flash');
  assert.equal(requests[0].reasoning.enabled, false);
  assert.equal(requests[0].max_tokens, 4);
  assert.equal(requests[0].provider.order[0], 'DeepInfra');
  assert.equal(requests[0].provider.zdr, true);
  assert.equal(requests[0].provider.data_collection, 'deny');
});
