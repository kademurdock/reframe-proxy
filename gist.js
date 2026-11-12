/* ── gist.js — what the thinking bubble is allowed to show ───────────────────
 * Part 92.19 (Aug 24 2026). Kade's ask, after changing her mind about hiding
 * thoughts entirely: "we need some kind of gist if the model is thinking, so
 * people at least feel like they know what's going on… but without divulging
 * prompting and all that kind of stuff."
 *
 * THE TWO REQUIREMENTS PULL AGAINST EACH OTHER, WHICH IS THE WHOLE DESIGN:
 *   1. LIVENESS. A static spinner is indistinguishable from a hang, and for a
 *      blind user that ambiguity is the actual problem — she cannot glance at
 *      the screen to see whether anything moved. Something must arrive, and it
 *      must keep arriving.
 *   2. PRIVACY. Reasoning streams LIVE into the bubble (reframe 8ecb839), and a
 *      model quotes its own instructions while it thinks. Kiana's persona names
 *      real people and carries verbatim family quotes about their own
 *      conversations. A thinking bubble on the wrong screen is mortifying in a
 *      way leaked prompt technique never is. That risk is already on the record:
 *      it is why the persona was de-identified on Aug 23.
 *
 * SO: forward the reasoning SENTENCE BY SENTENCE, and drop any sentence that is
 * about the instructions rather than about the person's actual question. What
 * survives is the model thinking out loud about the problem — which is exactly
 * the "I'm thinking about this and how that" she asked for. What never survives
 * is the half where it talks about its own rules.
 *
 * DEFAULT-DENY ON THE PARTS THAT MATTER. A sentence naming another person, or
 * quoting the system prompt, or reasoning about its own constraints, is dropped
 * whole — not redacted in place, because a half-scrubbed sentence still leaks
 * its shape ("I shouldn't tell ▇▇▇ about ▇▇▇'s appointment" says plenty).
 *
 * AND IT NEVER GOES SILENT. If a whole run of reasoning is dropped, the caller
 * gets a neutral keep-alive instead of nothing, because silence would put us
 * back at requirement 1 with extra steps.
 */

/* Sentences that are about the model's own instructions, not about the user's
 * problem. Deliberately broad: a false drop costs a little texture, a false
 * keep costs somebody's privacy. */
const SELF_REFERENTIAL = [
  /\b(system|developer)\s+(prompt|message|instruction)/i,
  /\bmy\s+(instructions?|persona|prompt|rules?|guidelines?|system)/i,
  /\bthe\s+(persona|instructions?|guidelines?|rules?)\s+(say|says|said|tell|tells|state|require)/i,
  /\bI'?m\s+(told|instructed|supposed|required|not allowed|meant)\b/i,
  /\bI\s+(should|must|shouldn'?t|mustn'?t|cannot|can'?t)\s+(not\s+)?(say|mention|reveal|tell|use|grant|instruct|end|ask)/i,
  /\brule\s*\d|\bthe\s+eight\b|\bcaretaker\b|\bcandyland\b/i,
  /\bnever\s+(grant|instruct|narrate|end by)\b/i,
  /\baccording to my\b|\bper my\b|\bas an ai\b/i,
  /\btool\s+(call|schema|definition|name)|\bfunction\s+call/i,
  /%%%|\[\s*(reset|laugh|sigh|breathe)\s*\]/i,
  /\bagent_[A-Za-z0-9_-]{6,}/,
];

/** Build the blocked-name matcher. Names come from the caller (env), because
 *  this module must not know the family. */
function nameMatcher(names) {
  const clean = (names || [])
    .map((n) => String(n || '').trim())
    .filter((n) => n.length >= 3);
  if (!clean.length) return null;
  const esc = clean.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + esc.join('|') + ')\\b', 'i');
}

function isSafeSentence(s, blockNames) {
  const t = String(s || '').trim();
  if (!t) return false;
  for (const re of SELF_REFERENTIAL) if (re.test(t)) return false;
  if (blockNames && blockNames.test(t)) return false;
  return true;
}

const MAX_PENDING = 600;

/* ASCII . ! ? newline, plus full-width 。！？ (a model thinking in Chinese ends sentences with these). */
function isSentenceEnd(c) {
  return c === 46 || c === 33 || c === 63 || c === 10 || c === 0x3002 || c === 0xff01 || c === 0xff1f;
}

/**
 * Streaming filter. Feed it reasoning deltas; it returns only text that is
 * safe to show, on sentence boundaries.
 *
 * Buffers partial sentences the same way the speech splitter does, and for the
 * same reason: a chunk boundary is not a thought boundary, and judging a half
 * sentence gets the judgement wrong.
 *
 * Nov 12 2026 (gateway audit GW-1): each push looks only at the NEW characters,
 * so an unfinished run costs O(chunk). The old regex re-walked everything held
 * from every start position on every push: 3,000 held characters blocked the
 * event loop ~1 s, 5,000 ~7 s, and every phone stream on the gateway with it.
 * A sentence that runs past maxPending with no end is dropped WHOLE: the filter
 * skips until the next sentence end and drops that fragment too. Judging the
 * tail alone would show half of a sentence whose head carried the marker.
 * Every maxPending skipped characters count as one dropped sentence, so the
 * keep-alive below still arrives during a long run.
 */
function createGistFilter(opts) {
  const o = opts || {};
  const blockNames = nameMatcher(o.blockNames);
  const maxChars = o.maxChars || 600;      // texture, not a transcript
  const maxPending = o.maxPending || MAX_PENDING;
  let buffer = '';
  let emitted = 0;
  let droppedRun = 0;
  let sawAny = false;
  let skipping = false;   // inside an over-long sentence that was dropped
  let skipped = 0;

  function judge(sent) {
    if (emitted >= maxChars) { droppedRun++; return ''; }
    if (isSafeSentence(sent, blockNames)) {
      emitted += sent.length;
      droppedRun = 0;
      sawAny = true;
      return sent;
    }
    droppedRun++;
    return '';
  }

  return {
    /** @returns {string} text to forward downstream (may be '') */
    push(chunk) {
      const add = String(chunk == null ? '' : chunk);
      let out = '';
      let start = 0;
      // Only complete sentences are judged.
      for (let i = 0; i < add.length; i++) {
        if (!isSentenceEnd(add.charCodeAt(i))) continue;
        if (skipping) { skipping = false; skipped = 0; }   // tail of a dropped sentence: dropped with it
        else out += judge(buffer + add.slice(start, i + 1));
        buffer = '';
        start = i + 1;
      }
      const tail = start ? add.slice(start) : add;
      if (skipping) {
        skipped += tail.length;
        if (skipped >= maxPending) { skipped = 0; droppedRun++; }
      } else {
        buffer += tail;
        if (buffer.length > maxPending) { buffer = ''; skipping = true; skipped = 0; droppedRun++; }
      }
      /* Never go quiet just because the safe half ran out. Two dropped
       * sentences in a row and the bubble gets a neutral sign of life — the
       * point of the bubble is that something is moving. */
      if (!out && droppedRun >= 2) {
        droppedRun = 0;
        return sawAny ? ' ' : 'Working through it…';
      }
      return out;
    },
    /** End of stream: nothing partial is ever released — an unfinished
     *  sentence was never judged, and unjudged text does not ship. */
    flush() {
      buffer = '';
      skipping = false;
      skipped = 0;
      return '';
    },
    stats() { return { emitted, sawAny }; },
  };
}

module.exports = { createGistFilter, isSafeSentence, nameMatcher, SELF_REFERENTIAL };
