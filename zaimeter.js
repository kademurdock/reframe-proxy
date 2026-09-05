'use strict';
/**
 * zaimeter.js — Z.AI SPEND, METERED HERE (Sep 5 2026, Part 131).
 *
 * Z.AI has no balance or usage API (seven likely paths probed the night this
 * shipped, every one 404), and since Aug 21 the whole GLM lane — Kiana on
 * Flash until tonight, the memory keeper and compaction still — rides Z.AI
 * DIRECT. So the pot the background fleet runs on was invisible to the books.
 * This proxy sees every Z.AI response's `usage`, so it can keep the meter
 * itself: tokens x Z.AI's own stickers, per calendar day (UTC), served at
 * GET /zai-spend for the bridge's daily snapshot. In-memory (this service has
 * no volume); the bridge folds each day's number into its own ledger, so a
 * redeploy costs at most the minutes since the last snapshot.
 *
 * Stickers per million tokens: prompt / completion / cached-prompt.
 *   glm-5.3-flash  0.075 / 0.25 / 0.015 through 2026-09-09, then 0.15 / 0.50 / 0.03
 *   glm-5.3        1.40 / 4.40 / 0.14      glm-4.5-air  0.20 / 1.10 / 0.04
 *   glm-4.7-flashx 0.07 / 0.40 / 0.014     glm-4.7      0.60 / 2.20 / 0.12
 *   anything else glm-*: the glm-5.3 row (overstate rather than hide).
 */
const FLASH_PROMO_UNTIL = '2026-09-09'; // Z.AI: 24:00 UTC+8 on the 9th = 16:00Z; the day boundary is close enough for a meter

function rateFor(model, dayKey) {
  const m = String(model || '').toLowerCase().replace(/^z-ai\//, '');
  if (m.startsWith('glm-5.3-flash')) return dayKey <= FLASH_PROMO_UNTIL ? [0.075, 0.25, 0.015] : [0.15, 0.5, 0.03];
  if (m.startsWith('glm-4.5-air')) return [0.2, 1.1, 0.04];
  if (m.startsWith('glm-4.7-flashx')) return [0.07, 0.4, 0.014];
  if (m.startsWith('glm-4.7')) return [0.6, 2.2, 0.12];
  return [1.4, 4.4, 0.14];
}

function costOf(model, usage, dayKey) {
  if (!usage) return 0;
  const [pin, pout, pcache] = rateFor(model, dayKey);
  const cached = Number((usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || usage.cached_tokens || 0);
  const prompt = Math.max(0, Number(usage.prompt_tokens || 0) - cached);
  const completion = Number(usage.completion_tokens || 0);
  return (prompt * pin + cached * pcache + completion * pout) / 1e6;
}

function makeZaiMeter({ keepDays = 14, now = () => new Date() } = {}) {
  const days = {}; // dayKey -> { usd, calls, prompt, cached, completion }
  const bootAt = now().toISOString();
  function note(model, usage) {
    try {
      const dayKey = now().toISOString().slice(0, 10);
      const d = (days[dayKey] = days[dayKey] || { usd: 0, calls: 0, prompt: 0, cached: 0, completion: 0 });
      d.usd += costOf(model, usage, dayKey);
      d.calls += 1;
      const cached = Number((usage && usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) || (usage && usage.cached_tokens) || 0);
      d.prompt += Number((usage && usage.prompt_tokens) || 0);
      d.cached += cached;
      d.completion += Number((usage && usage.completion_tokens) || 0);
      const keys = Object.keys(days).sort();
      while (keys.length > keepDays) delete days[keys.shift()];
    } catch { /* a meter never breaks a reply */ }
  }
  function snapshot() {
    const out = {};
    for (const k of Object.keys(days).sort()) out[k] = { ...days[k], usd: Math.round(days[k].usd * 10000) / 10000 };
    const today = now().toISOString().slice(0, 10);
    return { bootAt, today, days: out, todayUSD: out[today] ? out[today].usd : 0, note: 'metered by the proxy from Z.AI usage x stickers; Z.AI has no balance API' };
  }
  return { note, snapshot, costOf, rateFor };
}

module.exports = { makeZaiMeter, costOf, rateFor };
