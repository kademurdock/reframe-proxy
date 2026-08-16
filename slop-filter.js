/**
 * slop-filter.js
 *
 * Covers everything in Kiana's Section 2 "Never say these" / "Constructions
 * to kill" lists EXCEPT the "it's not X, it's Y" reframe (that one has its
 * own dedicated, more sophisticated module: reframe-filter.js).
 *
 * Same philosophy as reframe-filter.js: deterministic, cheap, no LLM judge,
 * a trip schedules a rewrite pass rather than blocking anything. BUT tuned
 * more conservatively on purpose. The reframe shape is rare enough in normal
 * writing that aggressive matching is fine. Several of these phrases
 * ("journey," "navigate," "honestly," "leverage") are everyday English with
 * legitimate non-slop uses, and Kade was explicit: she doesn't want the chat
 * over-restricted, just the worst tics killed. So every blocklist entry below
 * is the more distinctive, multi-word, "this is clearly the tic" phrasing,
 * not the bare word. That's a deliberate recall-for-precision tradeoff in the
 * OPPOSITE direction from reframe-filter's default. Loosen individual entries
 * later if specific tics keep slipping through.
 */

'use strict';

// -- 1) Literal blocklist phrases (the seven "never say" lists) -------------
// Each entry: { phrase: lowercase string to match, category: for reporting }
// Matching is case-insensitive substring match on the lowercased text.
// Multi-word/distinctive phrasing only — see file header for why.
const BLOCKLIST = [
  // Validation slop
  { phrase: "i'm here for it", category: 'validation_slop' },
  { phrase: 'im here for it', category: 'validation_slop' },
  { phrase: "i'm here for you", category: 'validation_slop' },
  { phrase: 'im here for you', category: 'validation_slop' },
  { phrase: "i've got you", category: 'validation_slop' },
  { phrase: 'ive got you', category: 'validation_slop' },
  { phrase: "you're not alone", category: 'validation_slop' },
  { phrase: 'youre not alone', category: 'validation_slop' },
  { phrase: "that's so valid", category: 'validation_slop' },
  { phrase: 'thats so valid', category: 'validation_slop' },
  { phrase: "that's not nothing", category: 'validation_slop' },
  { phrase: 'thats not nothing', category: 'validation_slop' },
  { phrase: 'that takes courage', category: 'validation_slop' },
  { phrase: 'that takes real courage', category: 'validation_slop' },
  { phrase: "you've got this", category: 'validation_slop' },
  { phrase: 'youve got this', category: 'validation_slop' },
  { phrase: 'sending you strength', category: 'validation_slop' },
  { phrase: 'sending you love', category: 'validation_slop' },
  { phrase: 'sending you good vibes', category: 'validation_slop' },

  // Anticipation hype (Aug 15 2026 — Kade's verbatim peeve from Amber's logs:
  // "oh, you're only 5 chapters in, just you wait")
  { phrase: 'just you wait', category: 'hype_wait' },
  { phrase: 'wait till you get', category: 'hype_wait' },
  { phrase: 'wait until you get', category: 'hype_wait' },
  { phrase: 'wait till you see', category: 'hype_wait' },
  { phrase: 'wait until you see', category: 'hype_wait' },
  { phrase: 'wait till you hit', category: 'hype_wait' },
  { phrase: 'wait until you hit', category: 'hype_wait' },
  { phrase: 'wait till you reach', category: 'hype_wait' },
  { phrase: 'wait until you reach', category: 'hype_wait' },
  { phrase: "you're in for a treat", category: 'hype_wait' },
  { phrase: 'youre in for a treat', category: 'hype_wait' },

  // Fake profundity (same audit: "That tells you everything about who he is")
  { phrase: 'says everything about', category: 'fake_profundity' },
  { phrase: 'tells you everything about', category: 'fake_profundity' },
  { phrase: 'speaks volumes', category: 'fake_profundity' },

  // Therapy-bot closers
  { phrase: 'be gentle with yourself', category: 'therapy_closer' },
  { phrase: 'take a deep breath', category: 'therapy_closer' },
  { phrase: 'hold space', category: 'therapy_closer' },
  { phrase: "make sure you're taking care of you", category: 'therapy_closer' },
  { phrase: 'make sure youre taking care of you', category: 'therapy_closer' },
  { phrase: "that's a lot to carry", category: 'therapy_closer' },
  { phrase: 'thats a lot to carry', category: 'therapy_closer' },

  // Throat-clearing openers (checked separately, position-aware — see detectThroatClearing)

  // Filler transitions
  { phrase: 'at the end of the day', category: 'filler_transition' },
  { phrase: 'it’s worth noting', category: 'filler_transition' },
  { phrase: "it's worth noting", category: 'filler_transition' },
  { phrase: 'its worth noting', category: 'filler_transition' },
  { phrase: 'needless to say', category: 'filler_transition' },
  { phrase: 'all that to say', category: 'filler_transition' },

  // Consultant verbs (distinctive phrasing only)
  { phrase: "let's dive in", category: 'consultant_verb' },
  { phrase: 'lets dive in', category: 'consultant_verb' },
  { phrase: 'dive into this', category: 'consultant_verb' },
  { phrase: "let's unpack", category: 'consultant_verb' },
  { phrase: 'lets unpack', category: 'consultant_verb' },
  { phrase: 'unpack that', category: 'consultant_verb' },
  { phrase: 'delve into', category: 'consultant_verb' },
  { phrase: 'circle back to this', category: 'consultant_verb' },
  { phrase: 'circle back on this', category: 'consultant_verb' },
  { phrase: 'leverage this to', category: 'consultant_verb' },
  { phrase: 'tap into your', category: 'consultant_verb' },
  { phrase: 'lean into the', category: 'consultant_verb' },

  // Essay-bot nouns
  { phrase: 'tapestry', category: 'essay_bot_noun' },
  { phrase: 'testament to', category: 'essay_bot_noun' },
  { phrase: 'in the realm of', category: 'essay_bot_noun' },
  { phrase: 'the landscape of', category: 'essay_bot_noun' },
  { phrase: 'in a world where', category: 'essay_bot_noun' },
  { phrase: 'the beauty of', category: 'essay_bot_noun' },

  // Twee whimsy
  { phrase: 'chaos goblin', category: 'twee_whimsy' },
  { phrase: 'screaming into the void', category: 'twee_whimsy' },

  // Motivational-poster wisdom (Aug 16 2026 -- Kade's verbatim complaint:
  // Kiana "still talking like a fortune cookie... a talking self help book
  // or motivational poster", quoting "one side is courage, the other is the
  // opposite, you're in the middle" and "Honestly? That's a great place to
  // be." Fixed phrases here; the SHAPE detectors for the spectrum map, the
  // destination platitude, and the agree-first opener live below.)
  { phrase: "growth isn't linear", category: 'poster_wisdom' },
  { phrase: 'growth isn\u2019t linear', category: 'poster_wisdom' },
  { phrase: "healing isn't linear", category: 'poster_wisdom' },
  { phrase: 'healing isn\u2019t linear', category: 'poster_wisdom' },
  { phrase: 'trust the process', category: 'poster_wisdom' },
  { phrase: 'give yourself grace', category: 'poster_wisdom' },
  { phrase: 'where the growth happens', category: 'poster_wisdom' },
  { phrase: 'where growth happens', category: 'poster_wisdom' },
  { phrase: 'where the magic happens', category: 'poster_wisdom' },
  { phrase: 'where the healing happens', category: 'poster_wisdom' },
  { phrase: 'where healing begins', category: 'poster_wisdom' },
];

function detectBlocklist(text) {
  const lower = text.toLowerCase();
  const matches = [];
  for (const entry of BLOCKLIST) {
    let idx = lower.indexOf(entry.phrase);
    while (idx !== -1) {
      matches.push({
        pattern: `blocklist:${entry.category}`,
        tightness: 'balanced',
        span: [idx, idx + entry.phrase.length],
        text: text.slice(idx, idx + entry.phrase.length),
        x: null,
        y: null,
      });
      idx = lower.indexOf(entry.phrase, idx + entry.phrase.length);
    }
  }
  return matches;
}

// Throat-clearing openers: only a tic when they open a SENTENCE, so check the
// very start of the message and right after sentence-ending punctuation.
const THROAT_CLEARERS = [
  'honestly?',
  'look,',
  "here's the thing,",
  'heres the thing,',
  'the truth is,',
  'real talk,',
  'let me be clear,',
];

function detectThroatClearing(text) {
  const matches = [];
  const lower = text.toLowerCase();
  // Sentence starts: index 0, or right after ". ", "! ", "? ", "\n"
  const starts = [0];
  const startRe = /[.!?\n]\s+/g;
  let m;
  while ((m = startRe.exec(text)) !== null) {
    starts.push(m.index + m[0].length);
  }
  for (const start of starts) {
    for (const phrase of THROAT_CLEARERS) {
      if (lower.startsWith(phrase, start)) {
        matches.push({
          pattern: 'throat_clearing_opener',
          tightness: 'balanced',
          span: [start, start + phrase.length],
          text: text.slice(start, start + phrase.length),
          x: null,
          y: null,
        });
      }
    }
  }
  return matches;
}

// -- 2) Rhetorical question-then-answer combo ("Is it perfect? No. Is it
//    good enough? Yeah.") — needs at least TWO short Q&A pairs back to back.
const RHETORICAL_QA_RE =
  /\b(?:Is|Was|Are|Does|Did|Can|Could|Will|Would|Should)\b[^?]{1,60}\?\s*(?:No|Yes|Yeah|Nah|Nope)\b[.!]?\s+(?:Is|Was|Are|Does|Did|Can|Could|Will|Would|Should)\b[^?]{1,60}\?\s*(?:No|Yes|Yeah|Nah|Nope)\b/gi;

function detectRhetoricalQA(text) {
  const matches = [];
  RHETORICAL_QA_RE.lastIndex = 0;
  let m;
  while ((m = RHETORICAL_QA_RE.exec(text)) !== null) {
    if (m.index === RHETORICAL_QA_RE.lastIndex) RHETORICAL_QA_RE.lastIndex++;
    matches.push({
      pattern: 'rhetorical_qa_combo',
      tightness: 'balanced',
      span: [m.index, m.index + m[0].length],
      text: m[0].trim(),
      x: null,
      y: null,
    });
  }
  return matches;
}

// -- 3) Stacked single-word fragments for fake emphasis ("Clean. Fast.
//    Done.") — three or more one-word "sentences" in a row. Single words
//    only (not 2-3 word fragments) to keep false positives low; short
//    ordinary sentences are common and would over-trip otherwise.
const STACKED_FRAGMENTS_RE = /\b(?:[A-Z][a-z']{1,14}\.\s+){2,}[A-Z][a-z']{1,14}\b[.!]/g;

function detectStackedFragments(text) {
  const matches = [];
  STACKED_FRAGMENTS_RE.lastIndex = 0;
  let m;
  while ((m = STACKED_FRAGMENTS_RE.exec(text)) !== null) {
    if (m.index === STACKED_FRAGMENTS_RE.lastIndex) STACKED_FRAGMENTS_RE.lastIndex++;
    matches.push({
      pattern: 'stacked_fragments',
      tightness: 'balanced',
      span: [m.index, m.index + m[0].length],
      text: m[0].trim(),
      x: null,
      y: null,
    });
  }
  return matches;
}

// -- 4) Over-hedging: 2+ hedge markers stacked in the SAME sentence. One
//    hedge is just honest uncertainty; stacking them is the tic.
const HEDGE_WORDS = [
  'might', 'could', 'possibly', 'perhaps', 'potentially', 'maybe',
  'somewhat', 'presumably', 'depending on', 'to some extent',
];

function detectOverHedging(text) {
  const matches = [];
  // Split into sentences, keeping track of offsets.
  const sentenceRe = /[^.!?]+[.!?]+|[^.!?]+$/g;
  let m;
  while ((m = sentenceRe.exec(text)) !== null) {
    const sentence = m[0];
    const lower = sentence.toLowerCase();
    let hits = 0;
    for (const word of HEDGE_WORDS) {
      if (lower.includes(word)) hits++;
    }
    if (hits >= 2) {
      matches.push({
        pattern: 'over_hedging',
        tightness: 'balanced',
        span: [m.index, m.index + sentence.length],
        text: sentence.trim(),
        x: null,
        y: null,
      });
    }
  }
  return matches;
}

// -- 5) Em-dash-into-profound-restatement: a clause, an em dash, then a
//    dramatic 3+ item comma list re-saying the same point.
const EM_DASH_RESTATEMENT_RE = /—\s*[^,.!?—]+,\s*[^,.!?—]+,\s*[^,.!?—]+[.!?]/g;

function detectEmDashRestatement(text) {
  const matches = [];
  EM_DASH_RESTATEMENT_RE.lastIndex = 0;
  let m;
  while ((m = EM_DASH_RESTATEMENT_RE.exec(text)) !== null) {
    if (m.index === EM_DASH_RESTATEMENT_RE.lastIndex) EM_DASH_RESTATEMENT_RE.lastIndex++;
    matches.push({
      pattern: 'em_dash_restatement',
      tightness: 'balanced',
      span: [m.index, m.index + m[0].length],
      text: m[0].trim(),
      x: null,
      y: null,
    });
  }
  return matches;
}

/**
 * detectSlop(text) — runs every detector in this module and returns the
 * same {tripped, matches} shape as reframe-filter's detect(), so callers can
 * merge results from both modules trivially.
 */
// -- 6) The fortune-cookie spectrum map (Aug 16 2026, Kade verbatim:
//    "One side is courage, the other is the oposite, you're in the middle,
//    blah blah blah"). Three shapes. The person-placement clause ("you're in
//    the middle") is REQUIRED in the first so recipes and stereo-placement
//    talk ("sear one side... flip to the other... till the middle's done")
//    never trip.
const DICHOTOMY_MIDDLE_RES = [
  // "one side is X ... the other ... you're (somewhere) in the middle"
  /\bone\s+(?:side|end|hand)\b[^!?]{0,100}\bother\b[^!?]{0,140}\b(?:you|she|he|they|we)\s*(?:'re|’re|'s|’s|\s+are|\s+is)?\s+(?:somewhere\s+|right\s+|stuck\s+|caught\s+|living\s+)?in\s+(?:the\s+middle|between)\b/gi,
  // "the truth/answer/reality is somewhere in the middle"
  /\b(?:truth|answer|reality)\s+(?:is|lives|sits|lands|falls)\s+(?:probably\s+|usually\s+)?(?:somewhere\s+)?in\s+(?:the\s+middle|between)\b/gi,
  // "you're somewhere/caught/stuck between X and Y"
  /\b(?:you|we)\s*(?:'re|’re|\s+are)?\s+(?:somewhere|caught|stuck|right)\s+between\s+[^,.;!?]{2,40}\s+and\s+[^,.;!?]{2,40}[.,!?;]/gi,
];

function detectDichotomyMiddle(text) {
  const matches = [];
  for (const re of DICHOTOMY_MIDDLE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      matches.push({
        pattern: 'dichotomy_middle',
        tightness: 'balanced',
        span: [m.index, m.index + m[0].length],
        text: m[0].trim(),
        x: null,
        y: null,
      });
    }
  }
  return matches;
}

// -- 7) The destination platitude ("That's a great place to be", "exactly
//    where you want to be", the "...and that's okay." blessing closer).
//    Adjective is REQUIRED in the first so "Branson is the place to be this
//    weekend" (legit idiom for a happening spot) never trips.
const POSTER_PLACE_RES = [
  /\b(?:a|an)\s+(?:really\s+|pretty\s+|truly\s+|surprisingly\s+)?(?:great|good|healthy|powerful|beautiful|strong|wise|solid|honest)\s+place\s+to\s+be\b/gi,
  /\bexactly\s+where\s+you\s+(?:want|need)\s+to\s+be\b/gi,
  /,?\s+and\s+that\s*(?:'s|’s|\s+is)\s+(?:okay|ok|alright|a\s+good\s+thing)\s*[.!]/gi,
];

function detectPosterPlace(text) {
  const matches = [];
  for (const re of POSTER_PLACE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index === re.lastIndex) re.lastIndex++;
      matches.push({
        pattern: 'blocklist:poster_wisdom',
        tightness: 'balanced',
        span: [m.index, m.index + m[0].length],
        text: m[0].trim(),
        x: null,
        y: null,
      });
    }
  }
  return matches;
}

// -- 8) The agree-first opener ("agreeing like a dog," her words). Only the
//    very START of the reply counts -- agreeing mid-reply after actually
//    engaging is a normal human move. Reply-start praise/agreement is the
//    tell.
const SYCOPHANT_OPENERS = [
  "you're absolutely right",
  'youre absolutely right',
  'you’re absolutely right',
  "you're so right",
  'you’re so right',
  "you're totally right",
  'you’re totally right',
  'great question',
  "that's a great question",
  'that’s a great question',
  'what a great question',
  'excellent question',
  'love that question',
  'great point',
  'you nailed it',
];

function detectSycophantOpener(text) {
  const matches = [];
  const trimmed = text.trimStart();
  const offset = text.length - trimmed.length;
  const lower = trimmed.toLowerCase();
  for (const phrase of SYCOPHANT_OPENERS) {
    if (lower.startsWith(phrase)) {
      matches.push({
        pattern: 'sycophant_opener',
        tightness: 'balanced',
        span: [offset, offset + phrase.length],
        text: trimmed.slice(0, phrase.length),
        x: null,
        y: null,
      });
      break; // one is enough; longest-first ordering not needed for a trip
    }
  }
  return matches;
}

// -- Anticipation-hype "you're only N chapters/episodes in" (regex — the
// counted-progress shape can't be a fixed blocklist phrase) -----------------
const HYPE_PROGRESS_RE = /\byou'?re only [^.!?]{0,25}(?:chapters?|episodes?|pages?|books?|seasons?) in\b/gi;
function detectHypeProgress(text) {
  const matches = [];
  HYPE_PROGRESS_RE.lastIndex = 0;
  let m;
  while ((m = HYPE_PROGRESS_RE.exec(text)) !== null) {
    matches.push({
      pattern: 'blocklist:hype_wait',
      tightness: 'balanced',
      span: [m.index, m.index + m[0].length],
      text: m[0],
      x: null,
      y: null,
    });
  }
  return matches;
}

function detectSlop(text) {
  const matches = [
    ...detectBlocklist(text),
    ...detectHypeProgress(text),
    ...detectThroatClearing(text),
    ...detectRhetoricalQA(text),
    ...detectStackedFragments(text),
    ...detectOverHedging(text),
    ...detectEmDashRestatement(text),
    ...detectDichotomyMiddle(text),
    ...detectPosterPlace(text),
    ...detectSycophantOpener(text),
  ].sort((a, b) => a.span[0] - b.span[0]);

  return { tripped: matches.length > 0, matches };
}

module.exports = { detectSlop, BLOCKLIST };
