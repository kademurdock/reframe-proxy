'use strict';
/**
 * slopstats.js — HOW OFTEN EACH SLOP CATEGORY FIRES, PER DAY, ASKABLE.
 *
 * Part 116 (Sep 1 2026, proposal 3). Part 114 shipped three new detector
 * categories (disclaimer_hedge / assistant_register / ai_self_reference) and
 * the only way to learn whether they fired in real traffic was to grep
 * Railway deploy logs. A detector nobody can count is a detector nobody can
 * tune. So: every trip is tallied here by category and by UTC day, and
 * `GET /slop-stats` hands the tally to the bridge, which speaks it in the
 * platform-status summary ("the disclaimer catcher fired 3 times yesterday").
 *
 * Same honesty contract as zaipulse.js: THIS LIVES IN MEMORY AND RESETS ON
 * EVERY REDEPLOY. Every snapshot carries `countingSince`, and a quiet window
 * and a freshly booted one look identical in the totals — the age is the only
 * thing that tells them apart, which is why it is always printed. Up to 14
 * UTC days are kept; older days fall off.
 *
 * Counted, per day:
 *   trips[category]   one per MATCH (a reply with two disclaimer hits = 2)
 *   replies           replies that tripped at least once
 *   outcomes          what happened to the tripped reply:
 *                       longform_kept  — over the rewrite cap, shipped as-is
 *                       rewrite_clean  — rewrite passed verify (or verify off)
 *                       second_pass    — first rewrite still tripped, took a 2nd
 *                       still_tripping — shipped after the 2nd pass still tripped
 *                       rewrite_failed — rewrite returned nothing / threw, original kept
 */

const KEEP_DAYS = 14;

function makeSlopStats(now = () => Date.now()) {
  const startedAt = new Date(now()).toISOString();
  /** dayKey -> { trips: {cat:n}, replies: n, outcomes: {name:n} } */
  const days = new Map();

  function dayKey(ts) {
    return new Date(ts).toISOString().slice(0, 10);
  }
  function bucket(ts) {
    const k = dayKey(ts);
    let b = days.get(k);
    if (!b) {
      b = { trips: {}, replies: 0, outcomes: {} };
      days.set(k, b);
      // prune
      const keys = [...days.keys()].sort();
      while (keys.length > KEEP_DAYS) {
        days.delete(keys.shift());
      }
    }
    return b;
  }
  /** Category name off a match's pattern: "blocklist:validation_slop" -> "validation_slop". */
  function categoryOf(pattern) {
    const p = String(pattern || 'unknown');
    return p.startsWith('blocklist:') ? p.slice('blocklist:'.length) : p;
  }

  return {
    /** Record one tripped reply. matches: [{pattern}], outcome: string. */
    record(matches, outcome) {
      const b = bucket(now());
      const list = Array.isArray(matches) ? matches : [];
      if (list.length > 0) {
        b.replies += 1;
      }
      for (const m of list) {
        const c = categoryOf(m && m.pattern);
        b.trips[c] = (b.trips[c] || 0) + 1;
      }
      if (outcome) {
        b.outcomes[outcome] = (b.outcomes[outcome] || 0) + 1;
      }
    },
    /** Record the outcome of an already-recorded reply (called after the rewrite settles). */
    outcome(name) {
      if (!name) return;
      const b = bucket(now());
      b.outcomes[name] = (b.outcomes[name] || 0) + 1;
    },
    snapshot() {
      const t = now();
      const today = dayKey(t);
      const yesterday = dayKey(t - 864e5);
      const out = {};
      for (const [k, v] of [...days.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
        out[k] = { trips: { ...v.trips }, replies: v.replies, outcomes: { ...v.outcomes } };
      }
      const y = days.get(yesterday) || { trips: {}, replies: 0, outcomes: {} };
      const td = days.get(today) || { trips: {}, replies: 0, outcomes: {} };
      const topOf = (b) =>
        Object.entries(b.trips)
          .sort((a, c) => c[1] - a[1])
          .slice(0, 4)
          .map(([category, n]) => ({ category, n }));
      const countingHours = Math.round(((t - Date.parse(startedAt)) / 36e5) * 10) / 10;
      return {
        countingSince: startedAt,
        countingHours,
        resetsOnDeploy: true,
        keepDays: KEEP_DAYS,
        today: { date: today, replies: td.replies, trips: sumTrips(td), top: topOf(td), outcomes: { ...td.outcomes } },
        yesterday: { date: yesterday, replies: y.replies, trips: sumTrips(y), top: topOf(y), outcomes: { ...y.outcomes } },
        days: out,
        /* one sentence for the ear; the bridge may use it verbatim */
        spoken: spokenLine(today, td, yesterday, y, countingHours),
      };
    },
  };
}

function sumTrips(b) {
  return Object.values(b.trips).reduce((a, n) => a + n, 0);
}

function say(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function nice(cat) {
  return String(cat).replace(/_/g, ' ');
}

function spokenLine(today, td, yesterday, y, hours) {
  const bits = [];
  const yt = sumTrips(y);
  const tt = sumTrips(td);
  if (hours < 24) {
    bits.push(`the slop counter has only been running ${hours} hours since the last deploy, so these are partial`);
  }
  if (yt === 0 && tt === 0) {
    bits.push('the slop filter has not tripped since it started counting');
    return bits.join('; ') + '.';
  }
  const top = (b) =>
    Object.entries(b.trips)
      .sort((a, c) => c[1] - a[1])
      .slice(0, 3)
      .map(([c, n]) => `${nice(c)} ${n}x`)
      .join(', ');
  if (yt > 0) {
    bits.push(`slop filter yesterday: ${say(y.replies, 'reply')} tripped (${top(y)})`);
    const o = y.outcomes;
    const fixed = (o.rewrite_clean || 0) + (o.second_pass || 0);
    if (fixed || o.longform_kept || o.still_tripping) {
      bits.push(
        `${fixed} rewritten clean, ${o.longform_kept || 0} long-form kept as written, ${o.still_tripping || 0} shipped still tripping`,
      );
    }
  } else {
    bits.push('slop filter yesterday: no trips');
  }
  if (tt > 0) {
    bits.push(`so far today ${say(td.replies, 'reply')} (${top(td)})`);
  }
  return bits.join('; ') + '.';
}

module.exports = { makeSlopStats, KEEP_DAYS };
