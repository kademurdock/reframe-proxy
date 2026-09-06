'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { isXaiModel, adaptForXai, xaiProviderPrefs, stripCacheControl, trailingSystemToUser, XAI_TAIL_HEADER } = require('./xai');

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

test('KADE_XAI_ZDR=0 kills the provider pin (the cache_control strip is a correctness fix and stays)', () => {
  const body = { model: 'x-ai/grok-4.20', messages: [{ role: 'user', content: 'hi' }] };
  const out = adaptForXai(body, { KADE_XAI_ZDR: '0' });
  assert.equal(out.provider, undefined);
  assert.deepEqual(out.messages, body.messages);
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

test('the trailing system reminder becomes a user message under the machinery header, IN FRONT of the person\'s words (132.4)', () => {
  const msgs = [{ role: 'system', content: 'P' }, { role: 'assistant', content: 'earlier' }, { role: 'user', content: 'Do you have an opinion about Elon Musk' }, { role: 'system', content: 'Quick style check' }];
  const out = trailingSystemToUser(msgs, {});
  assert.equal(out.length, 4);
  assert.equal(out[2].role, 'user');
  assert.equal(out[2].content, XAI_TAIL_HEADER + 'Quick style check');
  assert.strictEqual(out[3], msgs[2], 'the person\'s message is the last thing the model reads');
  assert.strictEqual(out[0], msgs[0]);
  /* the old placement, on the switch */
  const old = trailingSystemToUser(msgs, { KADE_XAI_TAIL_BEFORE_USER: '0' });
  assert.equal(old[3].content, XAI_TAIL_HEADER + 'Quick style check');
  /* first-turn shape: the SDK's runtime tail lands AFTER the words; both go in front now */
  const f = [{ role: 'system', content: 'P' }, { role: 'user', content: 'Do you have an opinion about Elon Musk' }, { role: 'user', content: '# Memory recall (auto-surfaced)\n- a card' }, { role: 'system', content: 'note' }];
  const o3 = trailingSystemToUser(f, {});
  assert.equal(o3.length, 4);
  assert.equal(o3[1].content, XAI_TAIL_HEADER + 'note');
  assert.equal(o3[2].content, '# Memory recall (auto-surfaced)\n- a card');
  assert.strictEqual(o3[3], f[1], 'her words are last');
  /* later-turn shape: context, words -> note, context, words */
  const g = [{ role: 'system', content: 'P' }, { role: 'assistant', content: 'a' }, { role: 'user', content: '# `web_search` Runtime Context' }, { role: 'user', content: 'short q' }, { role: 'system', content: 'note' }];
  const o4 = trailingSystemToUser(g, {});
  assert.deepEqual(o4.map((m) => m.content.slice(0, 12)), ['P', 'a', '# `web_searc', XAI_TAIL_HEADER.slice(0, 12), 'short q']);
  /* a tail with no user message right before it (tool result last) stays at the end */
  const t = [{ role: 'system', content: 'P' }, { role: 'user', content: 'q' }, { role: 'tool', content: 'r', tool_call_id: '1' }, { role: 'system', content: 'note' }];
  const o2 = trailingSystemToUser(t, {});
  assert.equal(o2[3].role, 'user'); assert.equal(o2[2].role, 'tool');
});

test('no trailing system, a lone system, or the kill switch: untouched', () => {
  const a = [{ role: 'system', content: 'P' }, { role: 'user', content: 'hi' }];
  assert.strictEqual(trailingSystemToUser(a, {}), a);
  const b = [{ role: 'system', content: 'P' }];
  assert.strictEqual(trailingSystemToUser(b, {}), b);
  const c = [{ role: 'system', content: 'P' }, { role: 'user', content: 'hi' }, { role: 'system', content: 'tail' }];
  assert.strictEqual(trailingSystemToUser(c, { KADE_XAI_TAIL_AS_USER: '0' }), c);
});
