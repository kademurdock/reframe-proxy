'use strict';

/* Oct 16 2026: -ultraspeed is the same checkpoint served faster (Xiaomi only,
 * about 10x the price). It counts as MiMo so the wordless guard, the explicit
 * reasoning switch and the retention rule below still hold if an agent is ever
 * pointed at it. Nothing here routes to it, and under zdr OpenRouter has no
 * host for it today, so such a turn errors instead of being kept by Xiaomi. */
const isMimoModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-(?:pro|flash)(?:-ultraspeed)?$/i.test(String(model || ''));
const isMimoProModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-pro$/i.test(String(model || ''));
const isMimoFlashModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-flash$/i.test(String(model || ''));

/* Oct 16 2026 speed test, direct to OpenRouter, same price on every machine.
 * Thinking OFF: DeepInfra's first word came in 0.7 s warm / 2.1 s cold on a
 * 22k-token prompt; Xiaomi took 5 s warm / 16 s cold. Output speed was about
 * the same (15-30 tokens a second on both). Thinking ON: DeepInfra stalled once
 * (a 47 s gap), but Xiaomi keeps prompts, so it is out either way (below).
 *
 * Her retention rule (Part 214: "slightly more worried about 0dr") holds here as
 * in deepseek.js, xai.js and sol.js: every MiMo body leaves with zdr and
 * data_collection deny, whatever the caller sent. OpenRouter's zdr list (Oct 15)
 * has Pro on DeepInfra and Novita only, and Novita is in EXCLUDED_PROVIDERS, so
 * Pro runs on DeepInfra alone: a DeepInfra outage fails the turn rather than
 * spilling onto Xiaomi or GMICloud. Flash has more zdr hosts (Makora, Io Net,
 * Venice), so DeepInfra goes first and fallback stays inside the filter.
 * Tune the order, never the filter: KADE_MIMO_PROVIDER_ORDER /
 * KADE_MIMO_THINK_PROVIDER_ORDER (comma lists, Pro only). */
const orderFrom = (name, fallback) =>
  String(process.env[name] ?? fallback).split(',').map((s) => s.trim()).filter(Boolean);
const PRO_ORDER_INSTANT = orderFrom('KADE_MIMO_PROVIDER_ORDER', 'DeepInfra');
const PRO_ORDER_THINKING = orderFrom('KADE_MIMO_THINK_PROVIDER_ORDER', 'DeepInfra');
const FLASH_ORDER = ['DeepInfra'];
/* A DeepInfra outage would fail every Pro turn under the rule above, so Pro
 * carries OpenRouter's model fallback: if no zdr host can serve Pro, the same
 * turn goes to MiMo Flash, which has four zdr hosts (proved Oct 16 with
 * provider.only Io Net: Pro had no host, Flash answered on Io Net). Same family,
 * same filter. Off: KADE_MIMO_FLASH_BACKUP=0. */
const FLASH_BACKUP = 'xiaomi/mimo-v2.6-flash';

function withMimoProvider(body, thinking = false) {
  if (!isMimoModel(body?.model)) return body;
  // An upstream order is kept; the retention rule is not negotiable.
  const existing = body.provider || {};
  const order = existing.order
    || (isMimoProModel(body.model) ? (thinking ? PRO_ORDER_THINKING : PRO_ORDER_INSTANT)
      : isMimoFlashModel(body.model) ? FLASH_ORDER : []);
  const provider = { ...existing, ...(order.length ? { order } : {}), allow_fallbacks: true, zdr: true, data_collection: 'deny' };
  if (provider.order) delete provider.sort; // OpenRouter rejects sort together with order
  const backup = isMimoProModel(body.model) && !Array.isArray(body.models) && process.env.KADE_MIMO_FLASH_BACKUP !== '0';
  return backup ? { ...body, models: [body.model, FLASH_BACKUP], provider } : { ...body, provider };
}

function adaptForMimo(body) {
  if (!isMimoModel(body?.model)) return body;
  const reasoning = { ...(body.reasoning || {}) };
  if (!reasoning.effort && typeof body.reasoning_effort === 'string') reasoning.effort = body.reasoning_effort;
  const effort = typeof reasoning.effort === 'string' ? reasoning.effort.toLowerCase() : '';
  const enabled = effort === 'none' || reasoning.enabled === false
    ? false
    : reasoning.enabled === true || ['low', 'medium', 'high', 'xhigh', 'max'].includes(effort);
  const next = {
    ...body,
    reasoning: { ...reasoning, ...(enabled ? {} : { effort: 'none' }), enabled },
  };
  delete next.reasoning_effort;
  if (!enabled) return withMimoProvider(next, false);
  // Xiaomi's thinking mode fixes its sampling; inherited character sliders are unsupported.
  delete next.temperature;
  delete next.top_p;
  const ceiling = Number(body.max_tokens ?? body.max_completion_tokens);
  const floor = ['high', 'xhigh', 'max'].includes(effort) ? 32000 : 16000;
  if (!Number.isFinite(ceiling) || ceiling < floor) {
    delete next.max_completion_tokens;
    next.max_tokens = floor;
  }
  return withMimoProvider(next, true);
}

module.exports = { isMimoModel, withMimoProvider, adaptForMimo };
