'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { adaptForSol, isSolModel } = require('./sol');
const { isReasoningModel, alwaysThinks, thinkTierFor, adaptForGlm, isWordlessTurn } = require('./modelbudget');

test('Sol reaches Auto thinking and the empty-output rescue under both model spellings', () => {
  for (const model of ['openai/gpt-6.1-sol', 'gpt-6.1-sol', 'openai/gpt-6.1-sol-20260929']) {
    assert.equal(isSolModel(model), true);
    assert.equal(isReasoningModel(model), true);
    assert.equal(alwaysThinks(model), true);
    assert.equal(isWordlessTurn({ model, finishReason: 'length', contentLength: 0 }), true);
  }
  assert.equal(isSolModel('openai/gpt-6-luna'), false);
});

test('Instant becomes supported low reasoning after routing and unsupported inherited sampling is removed', () => {
  const input = { model: 'openai/gpt-6.1-sol', reasoning: { effort: 'none', enabled: false, exclude: false },
    temperature: 0.85, top_p: 0.95, max_tokens: 4096, tools: [{ type: 'function', function: { name: 'test' } }] };
  const out = adaptForSol(adaptForGlm(input));
  assert.deepEqual(out.reasoning, { effort: 'low', exclude: false });
  assert.equal(out.max_completion_tokens, 16000);
  assert.equal(Object.hasOwn(out, 'max_tokens'), false);
  assert.equal(Object.hasOwn(out, 'temperature'), false);
  assert.equal(Object.hasOwn(out, 'top_p'), false);
  assert.deepEqual(out.tools, input.tools);
  assert.equal(input.reasoning.effort, 'none');
});

test('Explicit reasoning and larger caller budgets survive; only authoring Auto is capped', () => {
  const input = { model: 'openai/gpt-6.1-sol', max_completion_tokens: 70000,
    reasoning: { effort: 'high', exclude: true } };
  assert.equal(adaptForSol(adaptForGlm(input)).reasoning.effort, 'high');
  assert.equal(adaptForSol(adaptForGlm(input)).max_completion_tokens, 70000);
  const capped = adaptForSol({ ...input, kade_think_max_effort: 'medium' });
  assert.equal(capped.reasoning.effort, 'medium');
  assert.equal(Object.hasOwn(capped, 'kade_think_max_effort'), false);
});

test('Authoring effort is capped before the token floor is selected', () => {
  for (const effort of ['high', 'xhigh', 'max']) {
    const input = { model: 'openai/gpt-6.1-sol', max_tokens: 2200,
      reasoning: { effort, enabled: true }, kade_think_max_effort: 'medium' };
    assert.equal(thinkTierFor(input), 'think');
    const out = adaptForSol(adaptForGlm(input));
    assert.equal(out.reasoning.effort, 'medium');
    assert.equal(out.max_completion_tokens, 16000);
    assert.deepEqual(adaptForSol(adaptForGlm(out)), out);
    assert.equal(input.reasoning.effort, effort);
  }
  const explicit = { model: 'openai/gpt-6.1-sol', max_completion_tokens: 70000,
    reasoning_effort: 'high', kade_think_max_effort: 'medium' };
  const out = adaptForSol(adaptForGlm(explicit));
  assert.equal(out.reasoning.effort, 'medium');
  assert.equal(out.max_completion_tokens, 70000);
});

test('Retention is required even when callers supply provider preferences', () => {
  const out = adaptForSol({ model: 'openai/gpt-6.1-sol', provider: { zdr: false, data_collection: 'allow', only: ['azure'], sort: 'price' } });
  assert.equal(out.provider.zdr, true);
  assert.equal(out.provider.data_collection, 'deny');
  assert.deepEqual(out.provider.only, ['azure']);
  assert.equal(Object.hasOwn(out.provider, 'sort'), false);
  assert.deepEqual(adaptForSol(out), out);
});

test('Cheap workers and prior model routing stay intact', () => {
  const input = { model: 'deepseek/deepseek-v4.1-flash', temperature: 0.4, reasoning: { effort: 'none' }, max_tokens: 2000 };
  assert.equal(adaptForSol(input), input);
  const cleaned = adaptForSol({ ...input, kade_think_max_effort: 'medium' });
  assert.deepEqual(cleaned, input);
});
