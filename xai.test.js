'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isXaiModel, adaptForXai, xaiProviderPrefs, stripCacheControl } = require('./xai');

test('only x-ai/ models are touched', () => {
  assert.equal(isXaiModel('x-ai/grok-4.20'), true);
  assert.equal(isXaiModel('X-AI/grok-4.3'), true);
  assert.equal(isXaiModel('z-ai/glm-5.3-flash'), false);
  assert.equal(isXaiModel('glm-5.3'), false);
  assert.equal(isXaiModel(undefined), false);
  const glm = { model: 'z-ai/glm-5.3-flash', provider: { sort: 'price' } };
  assert.strictEqual(adaptForXai(glm, {}), glm);
});

test('the pin is zdr + price, and it overrides whatever the caller sent', () => {
  const out = adaptForXai({ model: 'x-ai/grok-4.20', provider: { zdr: false, sort: 'throughput', order: ['xAI'] } }, {});
  assert.deepEqual(out.provider, { zdr: true, sort: 'price' });
});

test('extra env prefs merge UNDER the pin', () => {
  const env = { KADE_XAI_PROVIDER: '{"allow_fallbacks":false,"zdr":false}' };
  assert.deepEqual(xaiProviderPrefs(env), { allow_fallbacks: false, zdr: true, sort: 'price' });
});

test('bad env JSON is ignored, pin still applies', () => {
  assert.deepEqual(xaiProviderPrefs({ KADE_XAI_PROVIDER: '{nope' }), { zdr: true, sort: 'price' });
});

test('KADE_XAI_ZDR=0 is the kill switch', () => {
  const body = { model: 'x-ai/grok-4.20', messages: [] };
  assert.strictEqual(adaptForXai(body, { KADE_XAI_ZDR: '0' }), body);
});

test('nothing else on the body moves', () => {
  const body = { model: 'x-ai/grok-4.20', messages: [{ role: 'user', content: 'hi' }], temperature: 0.85, reasoning: { effort: 'none' } };
  const out = adaptForXai(body, {});
  assert.equal(out.temperature, 0.85);
  assert.deepEqual(out.reasoning, { effort: 'none' });
  assert.deepEqual(out.messages, body.messages);
});

test('cache_control comes off every part and a lone text part collapses to a string', () => {
  const msgs = [
    { role: 'system', content: [{ type: 'text', text: 'PERSONA', cache_control: { type: 'ephemeral' } }] },
    { role: 'user', content: 'hi' },
    { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }, { type: 'image_url', image_url: { url: 'data:x' } }] },
  ];
  const out = stripCacheControl(msgs);
  assert.equal(out[0].content, 'PERSONA');
  assert.equal(out[1].content, 'hi');
  assert.deepEqual(out[2].content, [{ type: 'text', text: 'a' }, { type: 'image_url', image_url: { url: 'data:x' } }]);
  assert.strictEqual(stripCacheControl(msgs)[1], msgs[1]);
});

test('adaptForXai strips markers on x-ai and leaves other models byte-identical', () => {
  const body = { model: 'x-ai/grok-4.20', messages: [{ role: 'system', content: [{ type: 'text', text: 'P', cache_control: { type: 'ephemeral' } }] }] };
  assert.equal(adaptForXai(body, {}).messages[0].content, 'P');
  const glm = { model: 'z-ai/glm-5.3-flash', messages: body.messages };
  assert.strictEqual(adaptForXai(glm, {}), glm);
});
