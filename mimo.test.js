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
  const flash = adaptForMimo({ model: 'xiaomi/mimo-v2.6-flash', max_tokens: 4, reasoning_effort: 'none' });
  assert.equal(flash.reasoning.enabled, false);
  assert.equal(flash.max_tokens, 4);
  assert.equal(flash.provider.order[0], 'Xiaomi');
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
  assert.equal(requests[0].provider.order[0], 'Xiaomi');
});
