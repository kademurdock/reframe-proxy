/* echo-guard.js — two echoes a listener hears and no vocabulary list finds.
 *
 * Sep 11 2026, Part 178. Read straight off the nightly persona battery
 * (Sep 10 and Sep 11 runs, Kiana 69 both nights) and off Kade's own Sep 8–9
 * conversation, not off a theory:
 *
 *   1. PERSONA PARROT. Kiana's instructions carry a block of example
 *      exchanges ("Them: … / You: …") so the model can hear the register.
 *      The persona says, in so many words, "never reuse these exact lines;
 *      be the woman who'd say them." Grok 4.20 reuses them anyway. Two
 *      nights running the opinion probe answered with "that's like asking
 *      whether the engine or the road is better" — the Dolly/Whitney example
 *      verbatim — and the roast probe ran "a small regional airline for
 *      frozen tater tots" off the air-fryer example. Kade WROTE those lines.
 *      Hearing them read back is the single most quantifiable piece of
 *      "she sounds canned": the character is quoting her own script.
 *
 *      This channel is exact: a 5-word run that appears in a "You:" example
 *      line of the system prompt and again in the reply. It cannot false-
 *      trip on the target voice, because the target voice is defined as
 *      NOT saying these lines.
 *
 *   2. USER ECHO, near-verbatim only. Law 5 of her persona: "No recap. They
 *      were there." The Sep 8 jerky/Crumbl chat opened three replies in a
 *      row by restating her own point back at her. The deterministic form
 *      of that tell is a reply sentence whose content words are mostly the
 *      person's own words from the message she just sent. Paraphrased
 *      echoes are real too, and they are NOT caught here on purpose: a
 *      paraphrase detector guesses, and this proxy's rule is that a channel
 *      ships with zero false positives on the target voice or it does not
 *      ship. The paraphrase-level number is MEASURED (echoShare) and logged
 *      so a threshold can be found from labelled replies later instead of
 *      chosen today.
 *
 * Both channels return 'rewrite' matches in the shape every other detector
 * uses, so the existing rewrite pass handles them and slopstats counts them.
 * The parrot match carries the copied phrase in `detail` so the rewriter is
 * told WHICH words to lose, not just that some were copied.
 */

'use strict';

const TAG_RE = /%%%(.+?)%%%/gs;
const WORD_RE = /[a-z0-9']+/g;

const STOP = new Set(('i you it that this a an the and or but so to of in on for is am ' +
  'are was were be been do does did not no yes just really very my your me we ' +
  'if then than as at by with about like got get gonna wanna its it\'s that\'s ' +
  'he she they them his her their there here what which who how when where why').split(' '));

/* Requests for a repeat are not echoes. Same spirit as cadence-drift's
 * asksAgain, kept local so this module has no dependency on it. */
const ASKS_AGAIN_RE = /\b(repeat|say (that|it) again|again\?|one more time|read (that|it) back|what did (i|you) (just )?say|summar(y|ize|ise)|recap|go over (that|it) again|remind me)\b/i;

function words(s) { return (String(s || '').toLowerCase().match(WORD_RE) || []); }
function stripTags(s) { return String(s || '').replace(TAG_RE, ' '); }
function contentWords(s) { return words(s).filter((w) => !STOP.has(w)); }

/* Lines the character is told never to reuse: every "You:" line in any
 * system message, plus the lines that continue it until a blank line or the
 * next "Them:". Other agents with the same example grammar get the same
 * guard for free; agents without examples get an empty set and no channel. */
function exampleLinesFromSystem(systemText) {
  const out = [];
  const lines = String(systemText || '').split(/\r?\n/);
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(/^(?:You|Kiana)\s*:\s*(.*)$/i);
    if (m) {
      if (cur) out.push(cur);
      cur = m[1];
      continue;
    }
    if (cur !== null) {
      if (!line || /^(?:Them|User|Me)\s*(?:\(|:)/i.test(line) || /^#/.test(line)) {
        out.push(cur); cur = null;
      } else {
        cur += ' ' + line;
      }
    }
  }
  if (cur) out.push(cur);
  return out.map((l) => stripTags(l).trim()).filter((l) => words(l).length >= 5);
}

function systemTextOf(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  return msgs
    .filter((m) => m && m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : ''))
    .join('\n');
}

const PARROT_N = 5;
const PARROT_MAX = 3;

/* n-grams of an example line that are worth matching: at least two content
 * words, so "and i don't know if" style runs of glue never count. */
function shingleSet(text, n) {
  const w = words(text);
  const set = new Set();
  for (let i = 0; i + n <= w.length; i++) {
    const gram = w.slice(i, i + n);
    if (gram.filter((x) => !STOP.has(x)).length < 2) continue;
    set.add(gram.join(' '));
  }
  return set;
}

function detectPersonaParrot(content, systemText, opts = {}) {
  const n = opts.n || PARROT_N;
  const examples = Array.isArray(opts.exampleLines) ? opts.exampleLines : exampleLinesFromSystem(systemText);
  if (!examples.length) return [];
  const bank = new Set();
  for (const ex of examples) for (const g of shingleSet(ex, n)) bank.add(g);
  if (!bank.size) return [];
  const reply = words(stripTags(content));
  const hits = [];
  let i = 0;
  while (i + n <= reply.length) {
    const gram = reply.slice(i, i + n).join(' ');
    if (bank.has(gram)) {
      // extend the run as far as it keeps matching, so one copied sentence is one match
      let end = i + n;
      while (end < reply.length && bank.has(reply.slice(end - n + 1, end + 1).join(' '))) end++;
      hits.push(reply.slice(i, end).join(' '));
      i = end;
    } else {
      i++;
    }
  }
  const seen = new Set();
  const matches = [];
  for (const h of hits) {
    if (seen.has(h)) continue;
    seen.add(h);
    matches.push({
      pattern: 'persona_parrot', kind: 'rewrite', tightness: 'strict',
      span: [0, 0], x: null, y: null,
      text: h.slice(0, 80),
      detail: h.slice(0, 120),
    });
    if (matches.length >= PARROT_MAX) break;
  }
  return matches;
}

const ECHO_MIN_USER_CONTENT = 5;   // the person said enough to be echoed
const ECHO_MIN_SENT_CONTENT = 5;   // the sentence says enough to be an echo
const ECHO_SENT_SHARE = 0.7;       // this share of the sentence's content words are hers
const ECHO_MIN_SHARED = 4;         // and at least this many of them
const ECHO_MAX = 3;

function sentencesOf(text) {
  return stripTags(text).split(/(?<=[.!?])\s+|\n+/).map((t) => t.trim()).filter(Boolean);
}

/* Measured, always: what share of the person's content words came back in
 * the reply at all. Logged, never acted on (see header). */
function echoShare(content, humanText) {
  const u = new Set(contentWords(humanText).filter((w) => w.length > 3));
  if (u.size < ECHO_MIN_USER_CONTENT) return null;
  const r = new Set(contentWords(stripTags(content)));
  let n = 0; for (const w of u) if (r.has(w)) n++;
  return Math.round((n / u.size) * 100) / 100;
}

function detectUserEcho(content, humanText) {
  const human = String(humanText || '');
  if (ASKS_AGAIN_RE.test(human)) return [];
  const u = new Set(contentWords(human));
  if (u.size < ECHO_MIN_USER_CONTENT) return [];
  const matches = [];
  for (const s of sentencesOf(content)) {
    if (/\?\s*$/.test(s)) continue;              // a clarifying question may quote her
    if (/^["“']/.test(s)) continue;               // a deliberate quote is not an echo
    const cw = contentWords(s);
    if (cw.length < ECHO_MIN_SENT_CONTENT) continue;
    const shared = cw.filter((w) => u.has(w));
    if (shared.length >= ECHO_MIN_SHARED && shared.length / cw.length >= ECHO_SENT_SHARE) {
      matches.push({
        pattern: 'user_echo', kind: 'rewrite', tightness: 'strict',
        span: [0, 0], x: null, y: null,
        text: s.slice(0, 80),
        detail: s.slice(0, 160),
      });
      if (matches.length >= ECHO_MAX) break;
    }
  }
  return matches;
}

/* The one entry point server.js calls. humanText is the person's actual
 * message (the caller strips the fork's injected blobs); when it is absent
 * only the parrot channel runs. */
function detectEchoGuard(content, upstreamBody, { humanText = '' } = {}) {
  const out = [];
  try {
    out.push(...detectPersonaParrot(content, systemTextOf(upstreamBody)));
  } catch (e) {
    console.error('[echo-guard] parrot check threw, skipping:', e.message);
  }
  try {
    if (humanText) out.push(...detectUserEcho(content, humanText));
  } catch (e) {
    console.error('[echo-guard] user-echo check threw, skipping:', e.message);
  }
  return out;
}

module.exports = {
  detectEchoGuard,
  detectPersonaParrot,
  detectUserEcho,
  exampleLinesFromSystem,
  echoShare,
  _internals: { shingleSet, sentencesOf, contentWords, STOP },
};
