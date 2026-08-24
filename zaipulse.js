'use strict';
/**
 * zaipulse.js — WATCHING THE POT THE WHOLE FLEET HITS FIRST.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Every character on this platform — Kiana, Forge, Queen Amberline, Deuce,
 * Koji, Lyric, Cadence — runs `z-ai/glm-5.3`, and since Aug 21 2026 those
 * calls go to Z.AI DIRECT before OpenRouter is ever asked. Z.AI is the first
 * door every single turn walks through.
 *
 * It is not one of the five pots the platform snapshot watches.
 *
 * That gap was written down on Aug 23 (Part 92.1), again on Aug 24 (92.2),
 * and twice more the same night in Forge's own session notes — four flags,
 * nobody acted, because the obvious fix does not exist: Z.AI PUBLISHES NO
 * BALANCE API. There is no number to go and read. So the watch list kept its
 * five readable pots and quietly omitted the one that matters most.
 *
 * THIS IS THE SAME SHAPE AS THE CANARY THAT ONLY EVER TESTED THE CANARY AGENT.
 * On Aug 23 Kiana was down for two and a half hours while the canary stayed
 * green the whole time, because the canary measured a thing nobody used. A
 * monitor that does not watch what people actually depend on is not monitoring
 * it. Five pots with numbers and one without is exactly that mistake, wearing
 * the excuse that the number was hard to get.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * SO MEASURE WHAT WE ACTUALLY HAVE — WHICH IS BETTER THAN A BALANCE ANYWAY
 * ══════════════════════════════════════════════════════════════════════════
 *
 * We do not know Z.AI's balance. We know something more useful: whether Z.AI
 * is ANSWERING US, right now, on real family traffic. Every turn is already a
 * live probe; nothing was counting the results.
 *
 *   402 / 401 / 403  → the pot or the key. Money, or a credential that died.
 *   429              → throttling. The key works and the pot has money; we are
 *                      being rate-limited, which is a completely different
 *                      problem with a completely different fix.
 *
 * Collapsing those into one "Z.AI is sad" light is how a session spends an
 * evening topping up an account that was never empty. They are split here on
 * purpose, and the row says which it is.
 *
 * ⚠️ THIS COUNTER IS IN MEMORY AND RESETS ON REDEPLOY. Said out loud because
 * the harness ledger taught this exact lesson in Part 89 — a counter that
 * silently restarts at zero reads as "all clear" at the worst possible moment.
 * Every snapshot this module produces carries `since` and `resetsOnDeploy` so
 * the reader can tell a quiet hour from a fresh boot. Durability would mean a
 * volume, and a rate over a recent window does not need one; knowing the
 * window's age does.
 *
 * NO MODEL PREDICATE LIVES IN THIS FILE, ON PURPOSE. `isZaiDirectModel` stays
 * in server.js and the caller decides; this module only counts what it is
 * told. A second copy of a model-name predicate is precisely how the wordless
 * -turn guard was dead for three days (see modelbudget.js) — one predicate,
 * one home.
 */

/** How many recent outcomes to keep for the rolling rate. */
const WINDOW = 200;

/** Statuses that mean the pot or the key, not the throttle. */
const MONEY_OR_KEY = new Set([401, 402, 403]);

function makeZaiPulse({ window = WINDOW, now = () => Date.now() } = {}) {
  let since = now();
  let calls = 0;
  let ok = 0;
  let refused = 0;
  const byStatus = Object.create(null);
  let lastRefusalAt = null;
  let lastRefusalStatus = null;
  let lastOkAt = null;
  const recent = []; // true = refused

  return {
    /**
     * Record one Z.AI-direct outcome. The caller has already decided this call
     * went to Z.AI; this module does not second-guess it.
     */
    note(status) {
      /* ⚠️ `Number(null)` is 0 and `Number.isFinite(0)` is true, so an early
       * draft of this counted a null status as a call with status 0 — which
       * is below 400, so it landed in the OK column. A missing reading would
       * have been recorded as Z.AI ANSWERING FINE. Its own test caught it.
       * A bad reading must never round toward reassurance; that is the whole
       * lesson of the canary that stayed green through a two-and-a-half hour
       * outage. Only a plausible HTTP status counts as an observation. */
      const s = Number(status);
      if (!Number.isInteger(s) || s < 100 || s > 599) return;
      calls += 1;
      byStatus[s] = (byStatus[s] || 0) + 1;
      const isRefusal = s >= 400;
      if (isRefusal) {
        refused += 1;
        lastRefusalAt = now();
        lastRefusalStatus = s;
      } else {
        ok += 1;
        lastOkAt = now();
      }
      recent.push(isRefusal);
      while (recent.length > window) recent.shift();
    },

    snapshot() {
      const recentRefused = recent.filter(Boolean).length;
      const moneyOrKey = Object.entries(byStatus)
        .filter(([s]) => MONEY_OR_KEY.has(Number(s)))
        .reduce((n, [, c]) => n + c, 0);
      const throttled = byStatus[429] || 0;
      return {
        since: new Date(since).toISOString(),
        ageMinutes: Math.round((now() - since) / 60000),
        resetsOnDeploy: true,
        calls,
        ok,
        refused,
        byStatus: { ...byStatus },
        // The two halves that must never be collapsed into one light.
        moneyOrKey,
        throttled,
        recentWindow: recent.length,
        recentRefused,
        recentRefusalRate: recent.length ? Number((recentRefused / recent.length).toFixed(3)) : 0,
        lastRefusalAt: lastRefusalAt ? new Date(lastRefusalAt).toISOString() : null,
        lastRefusalStatus,
        lastOkAt: lastOkAt ? new Date(lastOkAt).toISOString() : null,
        verdict: verdictFor({ calls, moneyOrKey, throttled, recentRefused, recentLen: recent.length }),
      };
    },

    /** Test seam only. */
    _reset() {
      since = now(); calls = 0; ok = 0; refused = 0; lastRefusalAt = null;
      lastRefusalStatus = null; lastOkAt = null; recent.length = 0;
      for (const k of Object.keys(byStatus)) delete byStatus[k];
    },
  };
}

/**
 * One sentence a person can act on. Deliberately refuses to say anything at
 * all when nothing has been measured — "no data" and "healthy" are different
 * answers and the snapshot's whole job is not to confuse them.
 */
function verdictFor({ calls, moneyOrKey, throttled, recentRefused, recentLen }) {
  if (!calls) return 'no Z.AI calls seen since this process started — cannot say';
  if (moneyOrKey > 0) {
    return `⚠️ ${moneyOrKey} refusal(s) on money or key (401/402/403) — CHECK THE Z.AI BALANCE AND THE KEY`;
  }
  const rate = recentLen ? recentRefused / recentLen : 0;
  if (throttled > 0 && rate >= 0.2) {
    return `⚠️ throttled — ${throttled} × 429, ${Math.round(rate * 100)}% of the recent window fell back to OpenRouter. The key and the pot are fine; the rate limit is not.`;
  }
  if (throttled > 0) {
    return `${throttled} × 429 seen (throttle, not money) — fleet fell back to OpenRouter and kept answering`;
  }
  return 'answering — no refusals since this process started';
}

module.exports = { makeZaiPulse, verdictFor, MONEY_OR_KEY, WINDOW };
