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

const { detect: detectReframe } = require('./reframe-filter');

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

/* ── TEXTURE, MEASURED ONLY — NO STEER (Aug 22 2026, and this block is a
 * record of getting it wrong) ────────────────────────────────────────────
 *
 * Kade said Kiana "still reads like a textbook until you look at the
 * measurements." I measured 63 real replies, found a median of 1,391
 * characters and sixteen sentences, found that the persona never once used
 * the word "length", and shipped a steer that told her to be SHORTER.
 *
 * That was wrong, and she corrected it the same evening: "generally, I love
 * long messages. I love when people rant and just keep talking about things
 * until they have nothing left to talk about, because I'm a listener, and my
 * replies are always short." Matching a short question with a short answer --
 * which is exactly what one of the two channels did -- is the opposite of
 * what she wants. The length was never the complaint. The BUILD was.
 *
 * So what separates a rant she loves from an article she doesn't? The
 * candidate was sentence-length variation. The data killed it: her live long
 * replies vary MORE than the authored bank she approved (0.61 vs 0.52).
 * Fragment rate looked better -- approved 0.20, live 0.08 -- but every
 * threshold that flags the essays also flags 44% of the replies she signed
 * off on, and the approved long-reply sample is only nine items.
 *
 * A detector built on that would be a guess wearing a measurement's clothes,
 * and this proxy's whole rule is that a channel ships with zero false
 * positives on the target voice or it does not ship. So: NOTHING STEERS HERE.
 * These two numbers are recorded on every turn and nothing acts on them, so
 * that when she points at replies she actually liked there is a corpus with
 * both labels in it and a real threshold can be found instead of chosen.
 *
 * The guidance that DID ship for this lives in the persona, where it belongs:
 * keep the length, change the build -- an article covers a topic, a rant
 * chases the interesting part and stops when it runs out of things to say. */
const FRAG_WORDS = 4;      // a sentence this short is a beat, not a clause
const TEXTURE_MIN_SENTS = 4;

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

/* Sentences of a reply that carry enough content to be compared: tags off,
 * at least ECHO_MIN_WORDS content words. */
const ECHO_MIN_WORDS = 5;
const ECHO_SENT_SIM = 0.5;    // content-word overlap that makes two sentences one thought
const ECHO_MIN_HITS = 2;      // restated sentences before anything is said...
const ECHO_MIN_SHARE = 0.2;   // ...and a fifth of the newest reply
const ECHO_BIGRAM_SHARE = 0.12; // OR: this share of the reply's content bigrams already said...
const ECHO_BIGRAM_MIN = 15;   // ...and at least this many of them (a paraphrased recap)
const ECHO_BACK = 3;          // how many earlier replies the newest is checked against
/* words that recur in any restatement without naming its topic */
const ECHO_TOPIC_SKIP = new Set(('when without anything something nothing would could should still only ' +
  'even more most some into from than then there their what which where also back thing things going ' +
  'want need make sure keep give take have here they them those these will been being done know').split(' '));
function contentSentences(text) {
  return stripTags(text).split(/(?<=[.!?])\s+|\n+/)
    .map((t) => t.trim())
    .filter((t) => contentWords(t).length >= ECHO_MIN_WORDS);
}
function contentBigrams(text) {
  const w = contentWords(stripTags(text)).filter((x) => x.length > 2);
  const out = new Set();
  for (let i = 0; i + 1 < w.length; i++) out.add(w[i] + ' ' + w[i + 1]);
  return out;
}
/* Calibrated on Amber A's Sep 7 chat (nine Kiana replies, three of them
 * recaps a human flagged on sight) and her Sep 6 chat (eight replies, none):
 * the sentence rule alone caught only the near-verbatim recap (3 of 12
 * sentences at 0.58-0.83); the recaps a person hears are PARAPHRASED, and
 * what survives paraphrase is the content bigrams -- "hair catcher", "rubber
 * gasket", "product names" -- 36 of 152 (24%) on the worst reply, 19-23 on
 * the two milder ones, 5-12 on replies that were actually new, 0-5 on the
 * whole other chat. */
function contentEcho(history) {
  if (!Array.isArray(history) || history.length < 2) return null;
  const newestText = history[history.length - 1];
  const earlierTexts = history.slice(-(ECHO_BACK + 1), -1);
  const newest = contentSentences(newestText);
  const earlier = earlierTexts.flatMap(contentSentences);
  if (!newest.length || !earlier.length) return null;
  const hits = [];
  for (const s of newest) {
    let best = 0; let bestMate = null;
    for (const e of earlier) {
      const o = contentOverlap(s, e);
      if (o > best) { best = o; bestMate = e; }
    }
    if (best >= ECHO_SENT_SIM) hits.push({ s, e: bestMate });
  }
  const bySentence = hits.length >= ECHO_MIN_HITS && hits.length / newest.length >= ECHO_MIN_SHARE;
  const nb = contentBigrams(newestText);
  const eb = new Set();
  for (const t of earlierTexts) for (const g of contentBigrams(t)) eb.add(g);
  const repeated = [...nb].filter((g) => eb.has(g));
  const byBigram = nb.size >= ECHO_BIGRAM_MIN && repeated.length >= ECHO_BIGRAM_MIN && repeated.length / nb.size >= ECHO_BIGRAM_SHARE;
  if (!bySentence && !byBigram) return null;
  /* topic words: the content words that recur most across the repeated
   * material, so the note can name what to drop */
  const count = {};
  const bump = (w) => { if (w.length > 3 && !ECHO_TOPIC_SKIP.has(w)) count[w] = (count[w] || 0) + 1; };
  for (const g of repeated) g.split(' ').forEach(bump);
  for (const h of hits) {
    const mate = new Set(contentWords(h.e));
    for (const w of new Set(contentWords(h.s))) if (mate.has(w)) bump(w);
  }
  const topics = Object.keys(count).sort((a, b) => count[b] - count[a] || a.localeCompare(b)).slice(0, 4);
  return {
    hits: hits.length, of: newest.length, bigrams: repeated.length, ofBigrams: nb.size,
    topics: topics.length ? topics : ['the same points'],
  };
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

/* Compare completed conversational turns, retaining the user who prompted each
 * answer. Tool preambles/results and injected runtime users are not dialogue.
 * This is a conservative lexical signal, not semantic paraphrase detection.
 * Ambiguous short follow-ups and requested repetition opt out. No input changes.
 */
function conversationEcho(body, { isInjected = () => false, personText = t => t } = {}) {
  const turns = [];
  let pending = null;
  for (const m of Array.isArray(body?.messages) ? body.messages : []) {
    if (!m) continue;
    const text = msgText(m).trim();
    if (m.role === 'user' && text && !isInjected(text) && !/^<tool_response>/.test(text)) {
      if (pending?.answer) { turns.push(pending); pending = null; }
      const human = personText(text).trim();
      if (human) {
        if (!pending) pending = { user: human, answer: '' };
        else pending.user += '\n' + human;
      }
    } else if (m.role === 'assistant' && pending && text && !m.tool_calls?.length) {
      pending.answer += (pending.answer ? '\n' : '') + text;
    }
  }
  // At request time the last human turn must still be waiting for its answer.
  if (!pending || pending.answer || turns.length < 2) return null;
  const stopRepeat = text => {
    const t = text.replace(/[’‘]/g, "'");
    return /\b(?:stop|quit|avoid|don't|do not)\s+(?:\w+\s+){0,2}(?:repeat\w*|recap\w*|revisit\w*|bringing\s+(?:(?:that|this|it)\s+)?up)\b/i.test(t) ||
      /\byou(?:'ve| have)?\s+already\s+(?:said|covered|explained|mentioned)\s+(?:that|this|it)\b/i.test(t) ||
      /\byou\s+(?:said|covered|explained|mentioned)\s+(?:that|this|it)\s+already\b/i.test(t) ||
      /\bwe(?:'ve| have)?\s+(?:already\s+)?covered\s+(?:that|this|it)\b/i.test(t) ||
      /\byou(?:'re| are)\s+repeating\s+yourself\b/i.test(t);
  };
  const asksAgain = t => !stopRepeat(t) && (
    /(?:^|[.!?]\s+)(?:please\s+)?(?:repeat|recap|summari[sz]e|remind me|restate)\b/i.test(t) ||
    /\b(?:can|could|would|will) you (?:please )?(?:repeat|recap|summari[sz]e|remind|restate)\b/i.test(t) ||
    /\b(?:say|show|tell|explain|go over)\b[^.!?]{0,60}\bagain\b/i.test(t) ||
    /\b(?:want|need|like) (?:a|another|the) (?:recap|summary|repeat)\b/i.test(t)
  );
  const topicWords = t => new Set(contentWords(t).filter(w => w.length > 2 && !ECHO_TOPIC_SKIP.has(w)));
  const relevant = (user, sentence) => {
    if (stopRepeat(user)) return false;
    const u = topicWords(user); const s = topicWords(sentence);
    const shared = [...u].filter(w => s.has(w));
    // A named subject or an underspecified continuation may legitimately refer back.
    return shared.length >= 2 || shared.some(w => w.length >= 7) || u.size < 3;
  };
  const latest = turns[turns.length - 1];
  if (asksAgain(pending.user) || asksAgain(latest.user)) return null;
  const newest = contentSentences(latest.answer);
  const old = turns.slice(-13, -1).flatMap(t => contentSentences(t.answer));
  let hits = 0; let strongHits = 0;
  for (const sentence of newest) {
    if (relevant(latest.user, sentence) || relevant(pending.user, sentence)) continue;
    let best = 0;
    for (const earlier of old) best = Math.max(best, contentOverlap(sentence, earlier));
    if (best >= ECHO_SENT_SIM) hits++;
    if (best >= 0.75 && topicWords(sentence).size >= 6) strongHits++;
  }
  if (!strongHits && !(hits >= ECHO_MIN_HITS && hits / newest.length >= ECHO_MIN_SHARE)) return null;
  // Deliberately no topic words or copied passages in the model's final note.
  return { hits, strongHits, of: newest.length, priorTurns: Math.min(turns.length - 1, 12) };
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

  /* ---- 3b. TEXTURE, RECORDED, NEVER ACTED ON — see the header block.
   * No match is pushed. These land in debug so the shape of a reply is on the
   * record while the question of which shape she actually likes is still open. */
  {
    const stripped = String(content).replace(/%%%.*?%%%/gsu, ' ');
    const S = stripped.split(/(?<=[.!?])\s+/u).map((x) => x.trim()).filter(Boolean);
    debug.replyChars = content.length;
    debug.sentences = S.length;
    if (S.length >= TEXTURE_MIN_SENTS) {
      const words = S.map((x) => x.split(/\s+/u).filter(Boolean).length);
      debug.fragRate = Number((words.filter((w) => w <= FRAG_WORDS).length / words.length).toFixed(3));
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
function driftSteerNote(body, options) {
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

  /* Repetition steering uses paired human/assistant turns. A strong single
   * recycled sentence can count, but requested repeats and relevant follow-ups
   * opt out. Topic names are not copied into the final instruction. This remains
   * a next-reply reminder; it neither rewrites answers nor proves model compliance. */
  try {
    const echo = conversationEcho(body, options);
    if (echo) {
      options?.onEcho?.(echo);
      notes.push(
        `Repetition note: your last reply restated advice you had already given ` +
        `earlier while the person was discussing something else. Do not restate earlier advice ` +
        `just to acknowledge it or announce that it is resolved. Respond to the person's ` +
        `current message; keep relevant context, requested follow-ups and ongoing tool work. ` +
        `Leave unrelated finished subjects out. This is about relevance, not reply length.`
      );
    }
  } catch { /* a style check must never kill a turn */ }

  /* REFRAME HABIT (Aug 21 2026 — Kade, after v144's in-persona ban did not
   * hold: "I'm still seeing that's not blah, blah blah." Measured that
   * afternoon: 9 reframe constructions in 64 post-v144 replies, live
   * specimens hours old, while the response-side rewrite was timing out on
   * the thinking model (fixed the same session). The persona teaches;
   * this enforces. Same reasoning as the question-cadence note above: a
   * standing ban goes wallpaper, but a live count of THIS conversation's
   * habit — with the model's own latest specimen quoted back — does not.
   * Costs one detector pass over at most six strings, no model call. */
  let reframeTurns = 0;
  let reframeSpecimen = null;
  for (const h of history.slice(-W_CLOSER)) {
    try {
      const r = detectReframe(stripTags(h), { level: 'balanced' });
      if (r.tripped) {
        reframeTurns++;
        reframeSpecimen = r.matches[r.matches.length - 1].text;
      }
    } catch { /* a style check must never kill a turn */ }
  }
  if (reframeTurns >= 2) {
    notes.push(
      `Style note: ${reframeTurns} of your last ${Math.min(history.length, W_CLOSER)} replies leaned on the ` +
      `"that's not X, that's Y" relabel (latest: "${String(reframeSpecimen).slice(0, 70)}"). ` +
      `None of that this turn -- react to what they actually said and make your point straight, ` +
      `without telling them what their thing really is.`
    );
  }

  /* TAG METRONOME (Aug 21 2026 — measured: 291 of 295 recent replies, 99%,
   * open with a %%%tag%%% before a single word lands. Every message announcing
   * itself the same way IS a machine tell, and for a TTS listener it's the
   * same drumbeat on every reply. Fires only after 4 consecutive tag-opened
   * replies, so one bare opening buys at least 3 quiet turns — the note can't
   * go wallpaper, and the behavior it produces is a natural mostly-tagged
   * rhythm with human variance, not tag elimination (the tags are load-bearing
   * TTS steering; "drop the tag when the moment is plain" is already doctrine). */
  {
    let tagRun = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (String(history[i]).trim().startsWith('%%%')) tagRun++; else break;
    }
    if (tagRun >= 4) {
      notes.push(
        `Delivery note: your last ${tagRun} replies all OPENED with a voice tag. ` +
        `Open this one bare -- just start talking -- and if the moment needs a ` +
        `direction, let the tag land mid-message where the shift actually happens.`
      );
    }
  }

  /* FIRST-WORD STREAK — "Okay." three replies running is a tell no
   * single-message rule can see. Strict: 3 consecutive identical first words
   * (after tag strip), measured base rates show no word above 7% globally so
   * consecutive runs are genuine locks, not chance. */
  {
    const fw = (t) => ((stripTags(String(t)).trim().match(/^[A-Za-z']+/) || [''])[0] || '').toLowerCase();
    const last = history.slice(-3).map(fw);
    if (last.length === 3 && last[0] && last[0] === last[1] && last[1] === last[2]) {
      notes.push(
        `Style note: your last 3 replies all started with the word "${last[0]}". ` +
        `Start this one differently -- any other way in.`
      );
    }
  }

  /* PHRASE HABIT — verbal crutches the single-message tier can't see, because
   * any ONE of them is perfectly good speech. "here's the thing" measured in
   * 34 of 268 replies pre-v144 and still landing after. Extendable list. */
  const PHRASE_HABITS = [
    { name: '"here\'s the thing"', re: /\bhere'?s the thing\b/i, min: 2 },
  ];
  for (const ph of PHRASE_HABITS) {
    const n = history.slice(-W_CLOSER).filter((h) => ph.re.test(stripTags(h))).length;
    if (n >= ph.min) {
      notes.push(
        `Style note: ${ph.name} has shown up in ${n} of your last ${Math.min(history.length, W_CLOSER)} replies. ` +
        `Retire the phrase this turn -- just say the thing.`
      );
    }
  }

  /* OPINION PRESSURE (Aug 22 2026 — Kade: "She's still not REALLY being much
   * more than neutral... I don't wanna feel like I'm talking to a professor
   * or work friend." Measured the same night on 338 real replies: of 103
   * question-shaped turns, 15% of replies carried any stated take — and a
   * real user asked, in her own words, for straight over smooth the same
   * week. The persona already ORDERS a position (v146's A FRIEND STAKES A
   * CLAIM); this channel fires only when the live wire shows the order not
   * being followed: a direct what-do-you-think ask incoming AND no take in
   * the recent window. Steer, never rewrite — a position can't be patched
   * in after the fact, it has to be written from the start. */
  try {
    const lastUserArr = priorUser(body, 1);
    const lastUserText = String(lastUserArr[0] || '');
    const ASKS_TAKE = /\b(?:should (?:i|we)|what do you think|do you think|what would you (?:do|pick|choose|say)|which (?:one would|would you)|is (?:it|that|this) (?:worth|better|smart|stupid|crazy|a good idea)|good idea or|thoughts\?|your (?:take|opinion|read) on)\b/i;
    const HAS_TAKE = /\bmy (?:take|read|call|vote|honest read)\b|\bi think\b|\bi['\u2019]d (?:say|go|pick|take|call|do)\b|\bif it were me\b|\bfor my money\b|\bi vote\b|\bhere['\u2019]s where i land\b/i;
    if (ASKS_TAKE.test(lastUserText)) {
      const recent = history.slice(-3);
      const took = recent.filter((h) => HAS_TAKE.test(stripTags(String(h)))).length;
      if (took === 0) {
        notes.push(
          `Style note: they just asked what you actually think, and none of your ` +
          `recent replies staked a claim. Land a real position in one plain ` +
          `sentence -- with your reason -- before anything else. Once, warmly, ` +
          `and then it's their call.`
        );
      }
    }
  } catch { /* a style check must never kill a turn */ }

  return notes.length ? ' ' + notes.join(' ') : '';
}

module.exports = {
  detectDrift,
  splitDrift,
  driftSteerNote,
  registerOf,
  // exported for the harness + future tuning
  _internals: {
    lastSentence, firstClause, overlap, contentOverlap, promptRepeated, contentEcho, conversationEcho, contentSentences, contentBigrams,
    W_CLOSER, W_OPENER, W_QUESTION, Q_IN_W, REGISTER_RUN, SIM,
  },
};
