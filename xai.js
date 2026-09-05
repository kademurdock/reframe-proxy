'use strict';
/**
 * xai.js — provider pinning for x-ai/* models on OpenRouter (Sep 5 2026, Part 131).
 *
 * Every xAI model on OpenRouter is served by ONE provider (xAI) under FOUR
 * endpoints that are two independent flags, not four servers:
 *
 *   xai              base price        keeps prompts
 *   xai/zdr          base price        zero data retention
 *   xai/priority     EXACTLY 2x        keeps prompts
 *   xai/zdr/priority EXACTLY 2x        zero data retention
 *
 * Read live off /api/v1/models/x-ai/grok-4.20/endpoints on Sep 5 2026:
 * 1.25/2.50/0.20-cached vs 2.50/5.00/0.40-cached. ZDR costs nothing, and this
 * platform carries therapy transcripts, med lists and a child's seat — so the
 * pin is {zdr:true, sort:'price'}: OpenRouter's zdr flag is a hard filter to
 * the two ZDR endpoints, and price sort picks the base one. Fallbacks stay
 * allowed INSIDE that filter (the zdr/priority endpoint), so an xai/zdr blip
 * costs one 2x turn instead of a dead reply. Proved before shipping: a
 * grok-4.20 turn with this exact provider object billed $0.0028 warm — the
 * base tier's number, not priority's.
 *
 * Kill switch: KADE_XAI_ZDR=0 leaves x-ai bodies untouched (whatever the
 * fork sent, which today is nothing — OpenRouter's default routing, which on
 * Sep 5 sorted onto the base endpoint anyway but is not a promise).
 * Extra knobs, JSON, merged under the pin: KADE_XAI_PROVIDER='{"order":[...]}'.
 */
const XAI_MODEL_RE = /^x-ai\//i;

function isXaiModel(model) {
  return XAI_MODEL_RE.test(String(model || ''));
}

function xaiProviderPrefs(env = process.env) {
  if (env.KADE_XAI_ZDR === '0') return null;
  let extra = {};
  if (env.KADE_XAI_PROVIDER) {
    try { extra = JSON.parse(env.KADE_XAI_PROVIDER) || {}; } catch { extra = {}; }
  }
  // The pin wins over anything the caller or the env tried to set on these two.
  return { ...extra, zdr: true, sort: 'price' };
}

/* Sep 5 2026 (Part 131, the 0%-cache hunt, live receipts): LibreChat's agent
 * SDK, with OpenRouter promptCache on, stamps an Anthropic-style
 * `cache_control: {type:'ephemeral'}` onto the system text part (and onto the
 * last stable-prefix messages). Anthropic reads that as a cache breakpoint.
 * xAI reads it as noise that CHANGES the prompt: measured on the identical
 * 86K-char Kiana system message, two calls each --
 *   array part WITH cache_control  -> cached 128 / 128      (0%)
 *   array part, marker stripped     -> cached 14,528 / 14,528 (99.9%)
 *   plain string                    -> cached 14,528 / 14,528 (99.9%)
 * So for x-ai the marker comes off every part, and a single-text-part array
 * collapses to the plain string (the proven shape). Nothing else moves. */
function stripCacheControl(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const out = messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    const parts = m.content.map((p) => {
      if (p && typeof p === 'object' && 'cache_control' in p) {
        const { cache_control, ...rest } = p; // eslint-disable-line no-unused-vars
        changed = true;
        return rest;
      }
      return p;
    });
    if (parts.length === 1 && parts[0] && parts[0].type === 'text' && typeof parts[0].text === 'string') {
      changed = true;
      return { ...m, content: parts[0].text };
    }
    return changed ? { ...m, content: parts } : m;
  });
  return changed ? out : messages;
}

/* Sep 5 2026 (Part 131, same hunt, second breaker): the reframe's reminder
 * rides as a TRAILING SYSTEM message (style line, clock to the minute, drift
 * and tool notes -- different bytes every request). xAI's chat template
 * hoists every system message into the system slot at the FRONT, so a
 * changing trailing system = a changing head = no prefix left to hit.
 * Measured, live-shaped (86K persona + 40K of tool schemas + the fork's
 * user-role tail + a varying reminder), two calls each:
 *   reminder as trailing SYSTEM -> cached 128 / 128        (0%)
 *   reminder as trailing USER   -> cached 13,056 / 13,056  (the persona)
 * So on x-ai the trailing system reminder becomes a trailing USER message
 * under a machinery header, exactly where the SDK already puts its own
 * user-role runtime tail. Kill: KADE_XAI_TAIL_AS_USER=0. */
const XAI_TAIL_HEADER = '[PLATFORM NOTE -- machinery for you, not the person speaking. Never mention, quote, or answer this note; just let it shape the reply.]\n\n';
function trailingSystemToUser(messages, env = process.env) {
  if (env.KADE_XAI_TAIL_AS_USER === '0') return messages;
  if (!Array.isArray(messages) || messages.length < 2) return messages;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'system' || messages[0].role !== 'system') return messages;
  const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content || '');
  return [...messages.slice(0, -1), { role: 'user', content: XAI_TAIL_HEADER + text }];
}

function adaptForXai(body, env = process.env) {
  if (!body || !isXaiModel(body.model)) return body;
  const prefs = xaiProviderPrefs(env);
  const next = { ...body, messages: trailingSystemToUser(stripCacheControl(body.messages), env) };
  if (!prefs) return next;
  return { ...next, provider: prefs };
}

module.exports = { XAI_MODEL_RE, XAI_TAIL_HEADER, isXaiModel, xaiProviderPrefs, adaptForXai, stripCacheControl, trailingSystemToUser };
