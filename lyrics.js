'use strict';

const crypto = require('crypto');
const jev = require('./jev');

const MARKER = 'LYRIC — SONGWRITER AND CO-WRITER';
/* Sep 20 2026: the Sound Booth song desk's prompt has opened with this line since
 * the fork's Part 217, which matched neither the marker above nor the script
 * desk's opening in writing.js. Its drafts rode the ordinary chat lane: the voice
 * reminder went in, and on the way out the echo guard called the audit's copy of
 * the music direction a user echo and had the rewrite model redo the whole song.
 * One rewrite reworded the READBACK and dropped its label, and the engine sang
 * the description as the last lines of Kade's song. Keep this string identical
 * to musicWritingPrompt in the fork's packages/api/src/music/writing.ts. */
const SONG_DESK = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth.";

function systemTexts(body) {
  return (body?.messages || [])
    .filter((message) => message.role === 'system' || message.role === 'developer')
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
          : '',
    );
}

/* ── THE SECOND OPINION (Part 239, Sep 21 2026) ───────────────────────────
 * Kade approved the whole Jev ideas list, and this was the one at the top of
 * it. The comment above is a confession: two hardcoded `startsWith` strings,
 * kept in step by hand with a prompt that lives in ANOTHER REPO, and the day
 * the fork edited its opening line Kade's song came back with the music
 * direction sung into it. Nothing failed loudly. The lane just silently
 * stopped being the lyric lane.
 *
 * So Jev is asked the question the two strings are standing in for — "is this
 * prompt telling the model to write song lyrics?" — and the ANSWER IS
 * REMEMBERED AGAINST THE PROMPT, not the request. That choice is the whole
 * design:
 *   - `isLyricBody` stays synchronous and free, because `appendReminder` is
 *     synchronous and making it async would ripple through the proxy.
 *   - No request ever waits on Jev. The ask is fire-and-forget.
 *   - The fault this fixes is PERSISTENT — a prompt that changed opening
 *     line stays unmatched until a person notices — so learning the prompt
 *     once and protecting every turn after it is the right shape. The first
 *     request through a changed prompt is unprotected, exactly as today; the
 *     second onwards is protected, which is new.
 *
 * ADD-ONLY: this can only ever turn protection ON. Nothing here can make a
 * body stop being a lyric body, so the worst a wrong yes does is preserve
 * formatting on something that did not need it.
 *
 * The pre-filter matters for cost. Without it this would ask Jev about every
 * ordinary chat turn on the platform. A body only reaches the question if its
 * system prompt actually talks about songwriting, which no ordinary
 * conversation's system prompt does. Kill: KADE_JEV_LYRIC_LANE=0. */
const LOOKS_MUSICAL = /\b(song\w*|lyric\w*|verse|chorus|hook|songwrit\w*|co-?writer)\b/i;
const LYRIC_PROMPT_Q = {
  type: 'noul',
  instructions:
    'A system prompt given to a chat model is in `prompt`. Is it instructing the model to WRITE SONG LYRICS — to act as a songwriter or co-writer and hand back verses, a chorus or a full song? Only the instruction counts, not the subject matter: a prompt that merely talks about music, discusses songs, or asks about an artist is not this.',
  criteria: {
    true: 'It puts the model in the chair of a songwriter or lyricist and asks for sung words: verses, hooks, choruses, a draft, a rewrite of a lyric.',
    false: 'Anything else — ordinary conversation, a persona, a summariser, a title writer, a prompt that discusses music without asking for lyrics to be written.',
  },
};
const LEARNED_TTL_MS = 12 * 60 * 60 * 1000;
const learned = new Map(); // fingerprint -> expiry
const asking = new Set();

function fingerprint(text) {
  return crypto.createHash('sha1').update(String(text).slice(0, 400)).digest('hex').slice(0, 16);
}

function learnedLyric(texts) {
  const now = Date.now();
  for (const text of texts) {
    const until = learned.get(fingerprint(text));
    if (until && until > now) return true;
  }
  return false;
}

/** Fire and forget. Never throws, never awaited, never blocks a request. */
function learnLyricBody(body, { ask = jev.ask, log = console } = {}) {
  if (!jev.enabled('KADE_JEV_LYRIC_LANE')) return;
  const candidates = systemTexts(body).filter((text) => text.length > 40 && LOOKS_MUSICAL.test(text));
  for (const text of candidates) {
    const key = fingerprint(text);
    if (asking.has(key) || (learned.get(key) || 0) > Date.now()) continue;
    asking.add(key);
    Promise.resolve()
      .then(() => ask({ prompt: text.slice(0, 2000) }, { lyric: LYRIC_PROMPT_Q }, 2500))
      .then(({ answers }) => {
        const p = answers?.lyric?.noul;
        if (typeof p === 'number' && p >= Number(process.env.KADE_JEV_LYRIC_LANE_MIN || 0.8)) {
          learned.set(key, Date.now() + LEARNED_TTL_MS);
          log.log(`[kadeJev][lyric-lane] ${p.toFixed(2)} a songwriting prompt the two prefixes did not match — protected from here on (${key})`);
        }
      })
      .catch(() => {})
      .finally(() => asking.delete(key));
    if (learned.size > 200) {
      const now = Date.now();
      for (const [k, until] of learned) if (until <= now) learned.delete(k);
    }
  }
}

function isLyricBody(body) {
  const texts = systemTexts(body);
  if (texts.some((content) => content.startsWith(MARKER) || content.startsWith(SONG_DESK))) return true;
  return learnedLyric(texts);
}

const LYRIC_OUTPUT_NOTE = 'LYRIC OUTPUT: The user is working with a songwriter. For lyrics, verses, hooks, revisions, and production fields, preserve the requested format and line breaks. Do not add chat voice directions, percent-sign tags, reset tags, introductions, commentary, or a closing offer. The songwriting instructions govern these artifacts, including when the shared platform voice guidance asks for a direction. Normal music conversation may use your ordinary voice. Do not call a paid generation tool unless the user asks for audio.';

module.exports = {
  isLyricBody,
  learnLyricBody,
  LYRIC_OUTPUT_NOTE,
  _internals: { LYRIC_PROMPT_Q, LOOKS_MUSICAL, fingerprint, learned, systemTexts },
};
