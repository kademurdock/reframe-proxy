/* cadence-drift.js — the SEQUENCE detector.
 *
 * Aug 20 2026. Every other check in this proxy scores ONE message. The one
 * exception, detectCadenceLockins in server.js, does read history — but it
 * reads TWO messages and only their last sentence. Measured against 989 real
 * assistant turns out of the Aug-19 backup:
 *
 *   - closer repeats land at distance 1..6. A 2-window sees 22.5% of them.
 *     A 6-window sees 92.5%.  <-- this is the whole reason the window moves.
 *   - opener repeats run 6.5% of turns and NOTHING watches them.
 *   - %%% steering tags lock into one register for 3, 4, 5, and once TWELVE
 *     turns running. Nothing watches them either. A locked tag is written
 *     BEFORE the prose it governs, so it does not describe a stuck mood, it
 *     CAUSES one.
 *   - 39.2% of replies end on a question, and 15.6% end on a binary
 *     "X, or Y?" — the shape survives every single-message rule because any
 *     ONE of them is a perfectly good sentence.
 *
 * That last line is the thesis: the failure that rots a long conversation is
 * not a bad word, it is a good sentence used forty times. You cannot see it
 * from inside one message, which is why no vocabulary list finds it.
 *
 * ── remedy routing ──────────────────────────────────────────────────────
 * Two kinds of finding come out of here and they must NOT be treated alike:
 *
 *   kind:'rewrite'  the prose repeated itself -> the existing rewrite pass
 *                   can fix it, same as any other match.
 *   kind:'steer'    the DELIVERY locked -> a rewrite is the wrong tool. The
 *                   tag is authored before the paragraph, so rewriting the
 *                   paragraph leaves the cause untouched and spends a model
 *                   call to do it. These return a note for the NEXT request
 *                   instead. Cheaper and it fixes the actual thing.
 */

'use strict';

const TAG_RE = /%%%(.+?)%%%/gs;
const WORD_RE = /[a-z']+/g;

/* Windows are measured, not guessed — see the header. */
const W_CLOSER = 6;
const W_OPENER = 6;
const W_QUESTION = 4;      // "3 of your last 4" is the enforceable form of
const Q_IN_W = 3;          // the style reminder's "don't end on a question"
const REGISTER_RUN = 3;    // 3rd turn in one register is when a listener hears it
const SIM = 0.6;           // same threshold the shipped closer rule uses
const MIN_CLOSER_CHARS = 12;
const MIN_CLOSER_CONTENT = 3;   // "Bye for now." / "It has a cubby" are not tells
const MIN_OPENER_CONTENT = 3;   // guards "hey what's up" style false trips

/* Coarse on purpose. The complaint is "an hour of one identical mood", which
 * is a FAMILY, not an adjective. Vocabulary taken from tags actually present
 * in the corpus rather than invented. */
const REGISTER = {
  low_quiet: ['low', 'quiet', 'hushed', 'soft', 'gentle', 'steady', 'even',
    'careful', 'measured', 'calm', 'still', 'subdued', 'muted', 'unhurried'],
  warm: ['warm', 'fond', 'affectionate', 'tender', 'kind', 'sweet', 'soften'],
  bright: ['bright', 'light', 'playful', 'teasing', 'grinning', 'laughing',
    'amused', 'cheeky', 'wry', 'smirk', 'smiling'],
  hyped: ['hyped', 'excited', 'fast', 'loud', 'energetic', 'buzzing',
    'thrilled', 'eager', 'quick', 'rushing'],
  flat: ['flat', 'dry', 'deadpan', 'blunt', 'clipped', 'plain', 'matter of fact',
    'straightforward', 'direct', 'no softening', 'even keel'],
  heavy: ['heavy', 'sad', 'somber', 'grave', 'sober', 'weary', 'tired', 'hurt',
    'aching', 'raw', 'hollow'],
  sharp: ['sharp', 'hard', 'cold', 'edge', 'angry', 'furious', 'irritated',
    'tight', 'clipped off'],
};

const STOP = new Set(('i you it that this a an the and or but so to of in on for is am ' +
  'are was were be been do does did not no yes just really very my your me we ' +
  'if then than as at by with about like got get gonna wanna').split(' '));

function words(s) { return (String(s).toLowerCase().match(WORD_RE) || []); }
function stripTags(s) { return String(s).replace(TAG_RE, ' '); }
function contentWords(s) { return words(s).filter((w) => !STOP.has(w)); }

function overlap(a, b) {
  const A = new Set(words(a)); const B = new Set(words(b));
  if (!A.size || !B.size) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

/* CONTENT-word overlap. Measured false positives in the first harness pass
 * were nearly all function-word collisions: "to my eye no i'd probably want
 * to" scored 0.6+ against unrelated openers because eight-word fragments are
 * mostly stopwords, and a set intersection cannot tell "the/of/to matched"
 * from "the topic matched".
 *
 * Repetition of function words is English. Repetition of CONTENT is the tell.
 * Openers and closers are short enough that this distinction decides the
 * whole false-positive rate, so they score on content only; the prompt-echo
 * exemption keeps using full-word overlap because there it is comparing whole
 * user messages, where length makes stopwords harmless. */
function contentOverlap(a, b) {
  const A = new Set(contentWords(a)); const B = new Set(contentWords(b));
  if (A.size < 2 || B.size < 2) return 0;
  let n = 0; for (const w of A) if (B.has(w)) n++;
  return n / Math.max(A.size, B.size);
}

function lastSentence(text) {
  const t = stripTags(text).trim();
  const parts = t.split(/(?<=[.!?])\s+/);
  return (parts[parts.length - 1] || '').trim();
}

function firstClause(text, n = 8) {
  return words(stripTags(text)).slice(0, n).join(' ');
}

function registerOf(tag) {
  const t = String(tag).toLowerCase();
  const hits = [];
  for (const fam of Object.keys(REGISTER)) {
    if (REGISTER[fam].some((k) => t.includes(k))) hits.push(fam);
  }
  if (!hits.length) return null;          // unclassifiable -> never counts as a run
  return hits.sort().slice(0, 2).join('+');
}

function firstTag(text) {
  TAG_RE.lastIndex = 0;
  const m = TAG_RE.exec(String(text));
  return m ? m[1] : null;
}

/* Pull assistant turns out of an OpenAI-shaped body. Mirrors the tolerance
 * of cadenceMsgText in server.js: content can be a string or a parts array. */
function msgText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((p) => p && (p.type === 'text' || typeof p.text === 'string'))
      .map((p) => (typeof p.text === 'string' ? p.text : (p.text && p.text.value) || ''))
      .join('\n');
  }
  if (typeof m.text === 'string') return m.text;
  return '';
}

function priorAssistant(upstreamBody, n) {
  const msgs = Array.isArray(upstreamBody && upstreamBody.messages) ? upstreamBody.messages : [];
  return msgs.filter((m) => m && m.role === 'assistant')
    .map(msgText).filter((t) => t && t.trim())
    .slice(-n);
}

function priorUser(upstreamBody, n) {
  const msgs = Array.isArray(upstreamBody && upstreamBody.messages) ? upstreamBody.messages : [];
  return msgs.filter((m) => m && m.role === 'user')
    .map(msgText).filter((t) => t && t.trim())
    .slice(-n);
}

/* ── THE ECHO EXEMPTION ────────────────────────────────────────────────────
 * Measured false positives, both from the same root cause: the harness
 * flagged Spotter-style image descriptions ("of the view from my perspective
 * it has...") and repeated sign-offs, because the USER had asked the same
 * question again.
 *
 * If she asks the same thing twice, answering it the same way twice is
 * CORRECT. That is responsiveness, not drift. The disease is the model
 * repeating itself while the user moves on -- so before flagging any repeat,
 * check whether the prompt repeated first. If it did, this turn is exempt.
 *
 * This is the same principle the self-echo measurement used (subtracting the
 * user's n-grams before scoring), applied at the turn level. */
function promptRepeated(upstreamBody) {
  const us = priorUser(upstreamBody, 3);
  if (us.length < 2) return false;
  const latest = us[us.length - 1];
  for (let i = 0; i < us.length - 1; i++) {
    if (overlap(latest, us[i]) >= 0.55) return true;
  }
  return false;
}

/**
 * @param {string} content     the reply just produced
 * @param {object} upstreamBody the request it answered (carries the history)
 * @returns {{matches: Array, steer: string|null, debug: object}}
 */
function detectDrift(content, upstreamBody) {
  const matches = [];
  const steerNotes = [];
  const debug = {};

  const history = priorAssistant(upstreamBody, Math.max(W_CLOSER, W_OPENER, W_QUESTION, 12));
  debug.historyTurns = history.length;
  if (!history.length) return { matches, steer: null, debug };

  const exempt = promptRepeated(upstreamBody);
  debug.echoExempt = exempt;

  // ---- 1. closer repeat, at the distance the repeats actually live -------
  const cl = lastSentence(content);
  if (cl.length >= MIN_CLOSER_CHARS && contentWords(cl).length >= MIN_CLOSER_CONTENT && !exempt) {
    const window = history.slice(-W_CLOSER).map(lastSentence)
      .filter((c) => c.length >= MIN_CLOSER_CHARS && contentWords(c).length >= MIN_CLOSER_CONTENT);
    for (let i = window.length - 1; i >= 0; i--) {
      if (contentOverlap(cl, window[i]) >= SIM) {
        matches.push({
          pattern: 'repeated_closer_w6', kind: 'rewrite', tightness: 'strict',
          span: [0, 0], x: null, y: null,
          text: cl.slice(0, 80),
          distance: window.length - i,
        });
        break;
      }
    }
  }

  // ---- 2. opener repeat — nothing watched this before -------------------
  const op = firstClause(content);
  if (contentWords(op).length >= MIN_OPENER_CONTENT && !exempt) {
    const window = history.slice(-W_OPENER).map((t) => firstClause(t));
    for (let i = window.length - 1; i >= 0; i--) {
      if (contentWords(window[i]).length < MIN_OPENER_CONTENT) continue;
      if (contentOverlap(op, window[i]) >= SIM) {
        matches.push({
          pattern: 'repeated_opener', kind: 'rewrite', tightness: 'strict',
          span: [0, 0], x: null, y: null,
          text: op.slice(0, 80),
          distance: window.length - i,
        });
        break;
      }
    }
  }

  /* ---- 3. question habit: "3 of your last 4" -----------------------------
   * PRICED AS A STEER, NOT A REWRITE, and the measurement is why. This fires
   * on 17.9% of turns -- one in five replies buying an extra model call, on
   * a rewrite pass with a measured ~24% failure rate. That is a bad trade.
   *
   * It is also the wrong tool. The reply ends on a question because the model
   * DECIDED to ask one; a rewrite can only amputate it afterwards and leave
   * the turn ending on nothing. Telling it beforehand -- with the count, which
   * the static style reminder cannot do -- costs zero and fixes the cause.
   *
   * Note the standing reminder ALREADY says "do not end most replies with a
   * question." It has said so since Aug 15 and 33.8% of post-fix replies
   * still do. A constant instruction becomes wallpaper; a specific count
   * about THIS conversation does not. */
  if (cl.endsWith('?')) {
    const recent = history.slice(-(W_QUESTION - 1)).map(lastSentence);
    const priorQ = recent.filter((c) => c.endsWith('?')).length;
    if (priorQ + 1 >= Q_IN_W) {
      const n = priorQ + 1;
      const of = Math.min(W_QUESTION, history.length + 1);
      matches.push({
        pattern: 'question_habit', kind: 'steer', tightness: 'strict',
        span: [0, 0], x: null, y: null,
        text: cl.slice(0, 80),
        detail: `${n} of the last ${of} replies end on a question`,
      });
      steerNotes.push(
        `Cadence note: ${n} of your last ${of} replies ended on a question. ` +
        `End this one on the substance instead -- say the thing, or say ` +
        `nothing more. Only ask if you actually need the answer to continue.`
      );
    }
  }

  // ---- 4. register lock -> STEER, do not rewrite -------------------------
  const nowTag = firstTag(content);
  const nowReg = nowTag ? registerOf(nowTag) : null;
  if (nowReg) {
    let run = 1;
    const hist = history.slice().reverse();
    for (const t of hist) {
      const r = registerOf(firstTag(t) || '');
      if (r && r === nowReg) run++; else break;
    }
    debug.registerRun = run;
    debug.register = nowReg;
    if (run >= REGISTER_RUN) {
      matches.push({
        pattern: 'register_lock', kind: 'steer', tightness: 'strict',
        span: [0, 0], x: null, y: null,
        text: String(nowTag).slice(0, 80),
        detail: `${run} turns running in the "${nowReg}" register`,
      });
      steerNotes.push(
        `Delivery note: your last ${run} replies were all directed in the same ` +
        `register. Whatever this next one is, direct it somewhere else -- a ` +
        `different mood, a different pace, or drop the tag entirely if the ` +
        `moment is plain.`
      );
    }
  }

  return {
    matches,
    steer: steerNotes.length ? steerNotes.join(' ') : null,
    debug,
  };
}

/* Split helper for callers that route the two kinds differently. */
function splitDrift(res) {
  return {
    rewrite: res.matches.filter((m) => m.kind === 'rewrite'),
    steer: res.matches.filter((m) => m.kind === 'steer'),
    steerNote: res.steer,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * REQUEST-SIDE STEERING — and the reason this proxy needs no new state.
 *
 * The obvious design for "notice drift, then correct it next turn" is to
 * detect on the response and stash a note somewhere until the next request
 * arrives. That would mean per-conversation state in a proxy that has
 * deliberately never had any, plus an eviction policy, plus a bug class where
 * the note outlives the conversation it belongs to.
 *
 * None of that is necessary. The request ALREADY carries the history --
 * laneNoteFor(body) reads body.messages on every single text turn. So the
 * steer channels are computed at request time from the assistant turns
 * sitting right there, and appended to the note the model is about to read.
 * Stateless, exact, and it costs one pass over at most six strings.
 *
 * Division of labour:
 *   driftSteerNote(body)      request side  — the DELIVERY and CADENCE locks,
 *                             which must be fixed before the reply is written.
 *   detectDrift(content,body) response side — the PROSE repeats, which the
 *                             existing rewrite pass can genuinely repair.
 * ══════════════════════════════════════════════════════════════════════════ */
function driftSteerNote(body) {
  const history = priorAssistant(body, Math.max(W_QUESTION, W_CLOSER));
  if (history.length < 2) return '';
  const notes = [];

  // question cadence — count the run that already exists, before turn N+1
  const closers = history.slice(-(W_QUESTION)).map(lastSentence);
  const q = closers.filter((c) => c.endsWith('?')).length;
  if (q >= Q_IN_W) {
    notes.push(
      `Cadence note: ${q} of your last ${closers.length} replies ended on a ` +
      `question. End this one on the substance -- say the thing, then stop. ` +
      `Only ask if you actually need the answer to keep going.`
    );
  }

  // register lock — how many turns has the delivery been stuck already
  let run = 0; let fam = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const r = registerOf(firstTag(history[i]) || '');
    if (!r) break;
    if (fam === null) { fam = r; run = 1; } else if (r === fam) { run++; } else break;
  }
  if (fam && run >= REGISTER_RUN - 1) {
    notes.push(
      `Delivery note: your last ${run} replies were all directed in the same ` +
      `register. Direct this one somewhere else -- a different mood, a ` +
      `different pace -- or drop the tag entirely if the moment is plain.`
    );
  }

  /* TAG PHRASE ECHO (Aug 21 2026 — Kade, reading a raw transcript: "she
   * repeated herself." The prose was clean; the TAGS were the chorus —
   * "thinking it through steady and slow / steady / plain / steady thinking
   * it through" across four turns, "with a little shrug in it" twice. The
   * register-lock channel above missed it because mixed multi-family tags
   * fragment into composite keys that never equal each other. This channel
   * ignores families and catches the actual tell: the same content PHRASE
   * recycled across the window's tags. A stuck phrase is a stuck mood the
   * listener hears, and the author writes it BEFORE the paragraph it governs. */
  const windowTags = [];
  for (const h of history.slice(-W_CLOSER)) {
    TAG_RE.lastIndex = 0;
    let m; while ((m = TAG_RE.exec(String(h))) !== null) windowTags.push(m[1].toLowerCase());
  }
  if (windowTags.length >= 3) {
    const gramCount = {};
    for (const tag of windowTags) {
      const ws = tag.split(/\s+/).filter((w) => w.length > 1);
      const seen = new Set();
      for (let i = 0; i + 1 < ws.length; i++) {
        for (const n of [2, 3]) {
          if (i + n > ws.length) continue;
          const g = ws.slice(i, i + n).join(' ');
          if (g.split(' ').every((w) => STOP.has(w))) continue;
          if (!seen.has(g)) { seen.add(g); gramCount[g] = (gramCount[g] || 0) + 1; }
        }
      }
    }
    let echo = null;
    for (const g of Object.keys(gramCount)) {
      if (gramCount[g] >= 3 && (!echo || g.length > echo.length)) echo = g;
    }
    if (echo) {
      notes.push(
        `Delivery note: your recent voice directions keep reusing the phrase ` +
        `"${echo}" -- the delivery is stuck in one groove. Write this turn's ` +
        `direction from scratch in genuinely different words and a different ` +
        `mood, or drop the tag if the moment is plain.`
      );
    }
  }

  return notes.length ? ' ' + notes.join(' ') : '';
}

module.exports = {
  detectDrift,
  splitDrift,
  driftSteerNote,
  registerOf,
  // exported for the harness + future tuning
  _internals: {
    lastSentence, firstClause, overlap, contentOverlap, promptRepeated,
    W_CLOSER, W_OPENER, W_QUESTION, Q_IN_W, REGISTER_RUN, SIM,
  },
};
