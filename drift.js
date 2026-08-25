/* ── drift.js — the reply stopped being hers ─────────────────────────────────
 * Part 92.27 (Aug 25 2026). Kade's word: "all the sudden she starts writing
 * about cassio keyboards. I'm so confused." Then: "that can't happen again
 * with that cassio crap."
 *
 * WHAT HAPPENED. A reply answered her question about cereal-box mail-in prizes,
 * reached a clean natural ending — "Hard to beg your mom for that." — and then,
 * with no transition, emitted ~2,100 characters of a COMPLETE SUPPORT-FORUM
 * POST written by somebody else: "I think this is my second post here", a
 * numbered problem list about a Casio PX-S1100, "Any help, anecdotes, or
 * commiseration is appreciated. Thanks in advance!", and a sign-off asking
 * whether the post belonged in a different community. Training-data
 * regurgitation, not topic drift: it was internally coherent, in a different
 * voice, and carried a 💜 emoji Kiana does not use.
 *
 * ⚠️ WHY THIS IS FILED ABOVE "QUALITY". The regurgitated post was written by a
 * BLIND PERSON about accessibility — hearing aids, Bluetooth MIDI, a screen
 * reader. Read aloud in her voice to a blind family member, that does not sound
 * like a glitch. It sounds like Kiana talking about herself. Everybody on this
 * platform hears her rather than reads her, and a voice cannot show quote marks.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS AND IS NOT
 * ══════════════════════════════════════════════════════════════════════════
 *
 * This is a MITIGATION, not a cure. It does not stop the model regurgitating;
 * it finds the seam and lets the caller cut there, so the good answer survives
 * and the stranger's post does not reach a speaker. Saying that plainly here
 * because a guard that gets mistaken for a fix is how the real bug stops being
 * chased.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE PRECISION ARGUMENT, WHICH IS THE ONLY REASON THIS IS SAFE TO SHIP
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Measured before writing a line of it: every assistant message across Kade's
 * last 25 conversations — 83 replies — scanned for these markers.
 *
 *     1 true positive (the Casio reply).  0 false positives on the other 82.
 *
 * That ratio is the whole licence. This sits on the critical path of every
 * reply on the platform, and a guard that eats real answers is worse than the
 * bug it was built for.
 *
 * ⚠️ 83 replies is ONE SEAT. The Ambers' transcripts were not scanned — that
 * needs Kade's authorisation, not a session's convenience. Treat the false-
 * positive rate as "zero out of 82 on one person's phrasing", not as proven.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE FALSE POSITIVE THAT WOULD ACTUALLY HAPPEN, AND THE ESCAPE HATCH
 * ══════════════════════════════════════════════════════════════════════════
 *
 * Somebody asks her to DRAFT a forum post. "Write me a Reddit post asking about
 * X." Then every marker below fires on a reply that is exactly right, and a
 * naive guard truncates her actual work.
 *
 * So `findDrift` takes the user's own last message and stands down entirely
 * when it reads as a request to write/draft/post something. Default-allow on
 * that check, deliberately: if there is ANY sign the person asked for this
 * shape of text, the guard does nothing. A missed regurgitation costs one
 * confusing reply. A truncated draft costs her the thing she asked for, and
 * teaches her the tool eats her work.
 */

/* Phrases that belong to a forum post addressed to a crowd, and never to Kiana
 * talking to one person she knows. Each of these was present in the Casio
 * reply; none appeared in the other 82. Deliberately about ADDRESSING A GROUP
 * or POSTING, not about subject matter — a marker list about topics would be a
 * list of things she is allowed to discuss, which is the wrong shape entirely. */
const DRIFT_MARKERS = [
  /\bmy (?:first|second|third) post\b/i,
  /\bthis (?:community|subreddit|forum|group)\b/i,
  /\b(?:thanks|thank you) in advance\b/i,
  /\bhas anyone (?:here|else)\b/i,
  /\bany (?:help|advice|thoughts)[^.!?\n]{0,40}\b(?:appreciated|welcome)\b/i,
  /\bcommiseration\b/i,
  /\bif this (?:post|question) belongs\b/i,
  /\b(?:fine folks|fellow|hive ?mind)\b/i,
  /\b(?:cross-?posted|x-?posted)\b/i,
  /\b(?:TL;?DR)\b/,
  /\bwrong (?:sub|subreddit|forum)\b/i,
  /\b(?:upvot|downvot)/i,
  /\bposted (?:this )?(?:in|to) r\//i,
  /^\s*(?:edit|update)\s*\d*\s*:/im,
];

/* The person asked for this shape of text. Stand down. Broad on purpose — see
 * the escape-hatch note above. */
const ASKED_FOR_A_DRAFT = [
  /\b(?:write|draft|compose|word|help me with|make|create|post)\b[^.!?\n]{0,60}\b(?:post|thread|message|email|letter|review|listing|ad|blurb|bio|comment|question)\b/i,
  /\b(?:reddit|forum|facebook|craigslist|nextdoor|subreddit|marketplace)\b/i,
  /\bhow (?:do|would|should) i (?:write|word|ask|post|phrase)\b/i,
  /\bsound like (?:a|an) \w+ post\b/i,
];

/** Did the person ask for something post-shaped? */
function userAskedForDraft(userText) {
  const t = String(userText || '');
  if (!t.trim()) return false;
  return ASKED_FOR_A_DRAFT.some((re) => re.test(t));
}

/**
 * Walk back from a marker to the seam a person would recognise: the start of
 * the paragraph it sits in. Cutting mid-paragraph leaves a dangling half
 * sentence, which reads as a different bug and sends the next session chasing
 * truncation instead of regurgitation.
 */
function seamBefore(text, markerIndex) {
  const before = text.slice(0, markerIndex);
  const para = before.lastIndexOf('\n\n');
  if (para !== -1) return para;
  // No paragraph break (a run-on wall of text): fall back to the last sentence
  // end, so at least the cut lands somewhere a voice would pause.
  const sent = Math.max(
    before.lastIndexOf('. '), before.lastIndexOf('! '), before.lastIndexOf('? '),
  );
  return sent !== -1 ? sent + 1 : -1;
}

/**
 * Find where a reply stopped being hers.
 *
 * @param {string} text        the reply so far (safe to call on a partial stream)
 * @param {object} [opts]
 * @param {string} [opts.userText]  the person's own last message — the escape hatch
 * @param {number} [opts.minKeep]   don't cut unless this much good reply survives
 * @returns {{cut:number, marker:string, kept:number, dropped:number}|null}
 *          null means "nothing to do", which is the answer almost every time.
 */
function findDrift(text, opts = {}) {
  const s = String(text || '');
  const minKeep = Number.isFinite(opts.minKeep) ? opts.minKeep : 200;
  if (s.length < minKeep) return null;
  if (userAskedForDraft(opts.userText)) return null;

  let best = null;
  for (const re of DRIFT_MARKERS) {
    const m = re.exec(s);
    if (!m) continue;
    if (!best || m.index < best.index) best = { index: m.index, marker: String(re) };
  }
  if (!best) return null;

  const cut = seamBefore(s, best.index);
  /* The marker is in the FIRST paragraph, so there is no good answer in front
   * of it to save. That is not the Casio shape at all — that is a reply that
   * was post-shaped from its first word, which is far more likely to be
   * something she actually asked for than a regurgitation. Leave it alone and
   * let a human judge it. */
  if (cut < minKeep) return null;

  return {
    cut,
    marker: best.marker,
    kept: cut,
    dropped: s.length - cut,
  };
}

/** Convenience: the truncated reply, or the original when nothing tripped. */
function applyDrift(text, opts = {}) {
  const hit = findDrift(text, opts);
  if (!hit) return { text: String(text || ''), cut: false };
  return {
    text: String(text).slice(0, hit.cut).replace(/\s+$/, ''),
    cut: true,
    ...hit,
  };
}

module.exports = { findDrift, applyDrift, userAskedForDraft, DRIFT_MARKERS };
