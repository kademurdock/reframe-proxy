/* zai-vision.test.js — Aug 28 2026.
 *
 * Her first real native-vision turn died with Z.AI error 1210, and the cause
 * was the attachment-only send: LibreChat represents "a photo with no words"
 * as content = [{type:'text', text:''}, {type:'image_url', …}], and Z.AI
 * refuses an empty text part. Probed live against the real pot: text+image
 * 200, image-with-no-text-part 200, EMPTY-text+image 400 code 1210 — her
 * turn verbatim.
 *
 * Extracts the SHIPPED functions from server.js (never a transcription).
 * Runs standalone: node --test zai-vision.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const vm = require('vm');

const SRC = fs.readFileSync(require.resolve('./server.js'), 'utf8');

function extract(name, ctx) {
  const sig = `function ${name}(`;
  const start = SRC.indexOf(sig);
  assert.ok(start > -1, `${name} not found`);
  let i = SRC.indexOf('{', SRC.indexOf(')', start)), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  vm.runInContext(SRC.slice(start, end), ctx);
}

const ctx = {
  String, Array, Set, Math, Number, Boolean,
  process: { env: { ZAI_KEY: 'test-key' } },
  ZAI_KEY: 'test-key',
  ZAI_EFFORT_DIALECT_RE: /^glm-5\.[3-9]/i,
  ZAI_NEVER_THINK: new Set(['glm-4.7-flashx', 'glm-4.7-flash', 'glm-4.7', 'glm-4.6', 'glm-4.5-air']),
  isGlmModel: (m) => /^(?:z-ai\/)?glm[-.]/i.test(String(m || '')),
};
vm.createContext(ctx);
extract('stripEmptyTextParts', ctx);
extract('adaptForZai', ctx);
vm.runInContext('this.adaptForZai = adaptForZai; this.strip = stripEmptyTextParts;', ctx);
const { adaptForZai, strip } = ctx;

const IMG = { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } };

test("HER TURN: attachment-only send loses the empty text part, keeps the photo", () => {
  const body = adaptForZai({
    model: 'z-ai/glm-5.3-flash',
    messages: [{ role: 'user', content: [{ type: 'text', text: '' }, IMG] }],
  });
  const content = body.messages[0].content;
  assert.strictEqual(content.length, 1, 'the empty text part must be gone');
  assert.strictEqual(content[0].type, 'image_url', 'the image must survive');
});

test('whitespace-only text is empty too', () => {
  const out = strip([{ role: 'user', content: [{ type: 'text', text: '   \n' }, IMG] }]);
  assert.strictEqual(out[0].content.length, 1);
});

test('a REAL caption is never touched', () => {
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'who is this?' }, IMG] }];
  const out = strip(msgs);
  assert.strictEqual(out, msgs, 'a clean message must pass through by reference — zero copies on the happy path');
});

test('plain string content is untouched (the overwhelmingly common turn)', () => {
  const msgs = [{ role: 'user', content: 'hey girl' }];
  assert.strictEqual(strip(msgs), msgs);
});

test('only-empty-text collapses to the empty STRING, not a novel empty array', () => {
  const out = strip([{ role: 'user', content: [{ type: 'text', text: '' }] }]);
  assert.strictEqual(out[0].content, '');
});

test('idempotent: a second adapt pass cannot re-break what the first fixed', () => {
  const once = strip([{ role: 'user', content: [{ type: 'text', text: '' }, IMG] }]);
  const twice = strip(once);
  assert.strictEqual(twice, once);
});
