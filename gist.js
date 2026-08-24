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

/**
 * Streaming filter. Feed it reasoning deltas; it returns only text that is
 * safe to show, on sentence boundaries.
 *
 * Buffers partial sentences the same way the speech splitter does, and for the
 * same reason: a chunk boundary is not a thought boundary, and judging a half
 * sentence gets the judgement wrong.
 */
function createGistFilter(opts) {
  const o = opts || {};
  const blockNames = nameMatcher(o.blockNames);
  const maxChars = o.maxChars || 600;      // texture, not a transcript
  let buffer = '';
  let emitted = 0;
  let droppedRun = 0;
  let sawAny = false;

  return {
    /** @returns {string} text to forward downstream (may be '') */
    push(chunk) {
      buffer += String(chunk == null ? '' : chunk);
      let out = '';
      // Only complete sentences are judged.
      let m;
      const RE = /[^.!?\n]*[.!?\n]/g;
      let consumed = 0;
      while ((m = RE.exec(buffer)) !== null) {
        const sent = m[0];
        consumed = m.index + sent.length;
        if (emitted >= maxChars) { droppedRun++; continue; }
        if (isSafeSentence(sent, blockNames)) {
          out += sent;
          emitted += sent.length;
          droppedRun = 0;
          sawAny = true;
        } else {
          droppedRun++;
        }
      }
      buffer = buffer.slice(consumed);
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
      return '';
    },
    stats() { return { emitted, sawAny }; },
  };
}

module.exports = { createGistFilter, isSafeSentence, nameMatcher, SELF_REFERENTIAL };
