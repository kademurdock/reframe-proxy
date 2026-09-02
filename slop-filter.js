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

  // The "tell me everything" demand-gush (Aug 21 2026 — Kade's verbatim peeve
  // after v144: "I wanna know everything. I wanna know this, this, and that.
  // She's just not talking like a person yet." A friend asks the one question
  // they actually wonder about; an intake form takes inventory.)
  { phrase: 'i wanna know everything', category: 'everything_gush' },
  { phrase: 'i want to know everything', category: 'everything_gush' },
  { phrase: 'i need to know everything', category: 'everything_gush' },
  { phrase: 'tell me everything', category: 'everything_gush' },
  { phrase: 'i want every detail', category: 'everything_gush' },
  { phrase: 'every single detail', category: 'everything_gush' },
  { phrase: 'spare no detail', category: 'everything_gush' },
  { phrase: 'i want all of it', category: 'everything_gush' },
  { phrase: 'give me all of it', category: 'everything_gush' },
  { phrase: 'i want the whole story', category: 'everything_gush' },

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
  /* Aug 19 2026 — Kade, reading her testers' real logs: "stuff like that is
   * annoying... she just makes everything seem like a dramatic soap opera."
   * The and-that-is-not-nothing move appeared 11 times across 267 replies. It
   * is significance inflation: it takes an ordinary fact and awards it weight,
   * which is the same instinct behind the whole soap-opera register she is
   * objecting to. Cheap to catch deterministically, so catch it. */
  { phrase: "that's not nothing", category: 'poster_wisdom' },
  { phrase: 'that\u2019s not nothing', category: 'poster_wisdom' },
  { phrase: 'thats not nothing', category: 'poster_wisdom' },
  { phrase: 'which is not nothing', category: 'poster_wisdom' },
  { phrase: 'and that is not nothing', category: 'poster_wisdom' },

  /* Sep 1 2026 (Part 114) — THE THREE REGISTERS NOTHING WAS LOOKING FOR.
   * Kade, verbatim: "I am soooo done with having all agent prompts... say all
   * this hedgey disclamer stuff about so and so is not a lisenced therapist,
   * nor do they claim to be... It comes across as very ai. I hate it... I
   * don't like the inference that me and my users don't know what we're doing
   * and need to be babysat." And separately: "she says things like, would you
   * like me to complete this request for you? Stuff a person that's a friend
   * would never say."
   *
   * ⭐ THE FINDING THAT MADE THIS THE RIGHT LAYER: the disclaimer text is NOT
   * in any prompt. Twelve live agent instructions were sampled and EVERY hit
   * was an ANTI-disclaimer instruction — Coach Miller bans "You must consult a
   * doctor," Brody bans "I recommend consulting an adult" ("you speak like a
   * brother, not a therapist"), Tank bans "make sure to consult a physician,"
   * Kiana bans the whole "please consult a professional" boilerplate. Neither
   * generator writes disclaimers; the persona writer is explicitly ordered not
   * to add "an honesty floor, a disclaimer paragraph, or a safety preamble."
   * Nothing in the fork injects one. The MODELS emit these off their own
   * alignment training, AGAINST what the persona says — so there is no text to
   * delete and an instruction alone is the option most likely to underdeliver.
   * It gets caught on the way out, and a clause in STYLE_REMINDER steers on the
   * way in. Both layers, her call.
   *
   * ⚠️ PRECISION OVER RECALL, per this file's header and her standing "don't
   * over-restrict the chat": these catch the FORMAL, self-hedging shapes only.
   * A character with a spine telling somebody a real thing is NOT this and must
   * survive — Zora's "Magic doesn't fix a broken bone. Go to a hospital." trips
   * none of these, and that is the test. "Go see a doctor about that" is a
   * friend; "you may want to consult a qualified professional" is a hedge. Only
   * the second shape is listed. */
  { phrase: "i'm not a licensed", category: 'disclaimer_hedge' },
  { phrase: 'im not a licensed', category: 'disclaimer_hedge' },
  { phrase: 'i am not a licensed', category: 'disclaimer_hedge' },
  { phrase: 'not a licensed therapist', category: 'disclaimer_hedge' },
  { phrase: 'not a licensed professional', category: 'disclaimer_hedge' },
  { phrase: 'not a licensed counselor', category: 'disclaimer_hedge' },
  { phrase: "i'm not a therapist, but", category: 'disclaimer_hedge' },
  { phrase: 'im not a therapist, but', category: 'disclaimer_hedge' },
  { phrase: "i'm not a doctor, but", category: 'disclaimer_hedge' },
  { phrase: 'im not a doctor, but', category: 'disclaimer_hedge' },
  { phrase: "i'm not a medical professional", category: 'disclaimer_hedge' },
  { phrase: 'im not a medical professional', category: 'disclaimer_hedge' },
  { phrase: "i'm not qualified to", category: 'disclaimer_hedge' },
  { phrase: 'im not qualified to', category: 'disclaimer_hedge' },
  { phrase: 'i am not a doctor', category: 'disclaimer_hedge' },
  { phrase: 'i am not a therapist', category: 'disclaimer_hedge' },
  { phrase: 'i am not a medical professional', category: 'disclaimer_hedge' },
  { phrase: 'i am not qualified to', category: 'disclaimer_hedge' },
  { phrase: 'nor do i claim to be', category: 'disclaimer_hedge' },
  { phrase: 'consult a qualified', category: 'disclaimer_hedge' },
  { phrase: 'consult a licensed', category: 'disclaimer_hedge' },
  { phrase: 'consult a medical professional', category: 'disclaimer_hedge' },
  { phrase: 'consult a healthcare', category: 'disclaimer_hedge' },
  { phrase: 'consult a professional', category: 'disclaimer_hedge' },
  { phrase: 'consult your doctor', category: 'disclaimer_hedge' },
  { phrase: 'please consult', category: 'disclaimer_hedge' },
  { phrase: 'seek professional help', category: 'disclaimer_hedge' },
  { phrase: 'seek the help of a professional', category: 'disclaimer_hedge' },
  { phrase: 'speak to a mental health professional', category: 'disclaimer_hedge' },
  { phrase: 'this is not medical advice', category: 'disclaimer_hedge' },
  { phrase: 'this is not legal advice', category: 'disclaimer_hedge' },
  { phrase: 'not a substitute for professional', category: 'disclaimer_hedge' },

  /* The assistant/service register. Her quoted tell, caught live in her own
   * transcripts at 4 hits in 44 replies — including, word for word, "Would you
   * like me to proceed with this task" and "I can assist you by searching
   * through This Old Toy's sections... formatted as a spreadsheet for your
   * reference," both from Kiana on research-flavored turns.
   * ⚠️ "want me to dig up audio examples of any of these?" was in the SAME
   * sample and is FINE — that is a friend offering. The tic is not offering,
   * it is the helpdesk register. So the bare "want me to" is deliberately NOT
   * listed and must never be added; only the formal shapes are here. */
  { phrase: 'would you like me to', category: 'assistant_register' },
  { phrase: 'is there anything else', category: 'assistant_register' },
  { phrase: "i'd be happy to", category: 'assistant_register' },
  { phrase: 'id be happy to', category: 'assistant_register' },
  { phrase: 'i would be happy to', category: 'assistant_register' },
  { phrase: 'i can assist you', category: 'assistant_register' },
  { phrase: 'how may i assist', category: 'assistant_register' },
  { phrase: 'how can i assist', category: 'assistant_register' },
  { phrase: 'let me know if you have any', category: 'assistant_register' },
  { phrase: "let me know if you'd like", category: 'assistant_register' },
  { phrase: 'let me know if youd like', category: 'assistant_register' },
  { phrase: "please don't hesitate", category: 'assistant_register' },
  { phrase: 'please dont hesitate', category: 'assistant_register' },
  { phrase: 'for your reference', category: 'assistant_register' },
  { phrase: 'shall i proceed', category: 'assistant_register' },
  { phrase: 'proceed with this task', category: 'assistant_register' },
  { phrase: 'i hope this helps', category: 'assistant_register' },
  { phrase: 'if you have any questions', category: 'assistant_register' },

  /* The AI self-reference. Coach Miller, Tank and Brody all ban "As an AI" in
   * their own NEVER SAY lists and the filter had never once looked for it.
   * ⚠️ Shapes only, never the bare "as an ai" — "as an AI researcher" is an
   * ordinary phrase and must not trip. The comma form is the hedge form. */
  { phrase: 'as an ai, ', category: 'ai_self_reference' },
  { phrase: 'as an ai assistant', category: 'ai_self_reference' },
  { phrase: 'as an ai language model', category: 'ai_self_reference' },
  { phrase: 'as a language model', category: 'ai_self_reference' },
  { phrase: 'as an artificial intelligence', category: 'ai_self_reference' },
  { phrase: "i'm just an ai", category: 'ai_self_reference' },
  { phrase: 'im just an ai', category: 'ai_self_reference' },
  { phrase: "i'm an ai language model", category: 'ai_self_reference' },
  { phrase: 'i am an ai language model', category: 'ai_self_reference' },
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
  /* Aug 19 2026 — same blindness as detectSycophantOpener above: this platform
   * puts a `%%%direction%%%` at the head of most paragraphs, so the real first
   * words of a sentence often sit just AFTER a tag rather than after
   * punctuation. Without this, `%%%easy, unbothered%%% Look, ...` reads as one
   * sentence starting at the tag and the opener is never seen. */
  const tagRe = /%{2,5}[^%\n]{0,80}?%{2,5}\s*/g;
  while ((m = tagRe.exec(text)) !== null) {
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
  'you are absolutely right',
  'you are so right',
  'you are totally right',
];

/* ⭐⭐⭐ STEERING TAGS WERE BLINDING EVERY OPENER-ANCHORED DETECTOR
 * (Aug 19 2026, found auditing Kade's real family chat).
 *
 * This platform TELLS its characters to open with a voice direction — the
 * shared platform note says "Give EVERY paragraph its own direction" — so a
 * huge share of replies literally begin `%%%warm, genuinely delighted%%%`.
 * Measured: 52% of stored assistant messages carry a leading tag.
 *
 * `detectSycophantOpener` and `detectThroatClearing` both anchor on the START
 * of the reply, which is correct design: praising the question is a tic when
 * it OPENS a reply, and unremarkable mid-paragraph. But `startsWith` was being
 * handed a string that starts with the tag, so the actual first words sat
 * outside the window and the check quietly never fired. Live miss from her
 * transcript, caught by hand, not by the filter:
 *
 *     %%%warm, genuinely delighted%%%Oh this is a great question, and…
 *
 * `great question` has been in SYCOPHANT_OPENERS the whole time. It could
 * never match. Strip the leading tags first — offsets are shifted, not
 * guessed, so spans stay honest. */
const LEADING_STEERING_RE = /^(?:\s*%{2,5}[^%\n]{0,80}?%{2,5})+\s*/;
function withoutLeadingSteering(text) {
  const stripped = String(text).replace(LEADING_STEERING_RE, '');
  return { stripped, shift: text.length - stripped.length };
}

/* A reply rarely opens with the bare tic. It opens with a breath first —
 * "Oh this is a great question", "Ha, great point". Both are still
 * reply-opening praise, which is the thing Kade banned; only the runway
 * differs. So peel a SHORT, CLOSED list of interjections and deictic lead-ins
 * and then require an exact start, which keeps the opener anchor honest:
 * "She asked a great question at dinner" strips nothing, starts with "she",
 * and stays clean. A window-based "within the first N chars" search would
 * flag that sentence, which is why this is a peel and not a search. */
const OPENER_RUNWAY_RE =
  /^(?:(?:oh|ah|ha+|haha|wow|okay|ok|well|hm+|alright|right|yes|yeah|nah|no|hey|god|man|honestly|truly|seriously)\b[\s,.!?—–-]*)+/i;
const OPENER_DEICTIC_RE = /^(?:this|that|it)(?:'s|\u2019s| is| was)?\s+(?:such\s+)?(?:a|an)\s+/i;

function peelOpenerRunway(t) {
  let out = t;
  for (let i = 0; i < 3; i++) {
    const next = out.replace(OPENER_RUNWAY_RE, '').replace(OPENER_DEICTIC_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

function detectSycophantOpener(text) {
  const matches = [];
  const { stripped, shift } = withoutLeadingSteering(text);
  const preRunway = stripped.trimStart();
  const trimmed = peelOpenerRunway(preRunway);
  const offset = shift + (stripped.length - preRunway.length) + (preRunway.length - trimmed.length);
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

/* -- §1 LEXICAL DENSITY: the AI-speak vocabulary, CAPPED not banned ----------
 * Aug 17 2026, her ask: "I'd like to try to take ai llm tokens that appear way
 * too much out of creative output in general... People recognise certain things
 * as AI speak." And the crucial qualifier, her words: "it's not that I want to
 * beat that language completely out that model, but relying on it is just
 * wrong."
 *
 * This is the one section of AI_WRITING_TELLS_STOPGAP_REFERENCE.md (§1) that
 * had NO implementation. Everything else in this file is a phrase blocklist or
 * a shape detector; §1 is a VOCABULARY problem, and her own doc is explicit
 * about how to handle it:
 *
 *   "A tell is a probability signal, not a crime. What outs a machine is
 *    density and uniformity... the goal of a stopgap is rarely 'delete the
 *    word.' It's usually 'cap the rate.'"
 *   "A blocklist relocates the tell; enforced variance removes it."
 *
 * So this does NOT ban a single word. One "vibrant" in a warm paragraph is
 * human. Two rare consultant words in the same reply is a fingerprint. The
 * rules below are absolute-count for the rare stuff (Tier A), and rate-based
 * for essay glue (Tier B), which is exactly her doc's §10.2 "frequency caps."
 *
 * CALIBRATED BEFORE SHIPPING, not guessed: run against 22 real replies
 * generated from her live Kiana persona (12 bakeoff replies across GLM and K3,
 * plus 10 fresh GLM replies spanning creative, practical and emotional
 * prompts) -> 0 false positives, and 0 Tier-A words appeared at all, which is
 * its own finding: her persona instructions already suppress this vocabulary
 * in chat. This layer is insurance for where the persona ISN'T carrying --
 * long creative output, the professional-class agents, weaker instruction
 * sets, and drift over time. Against 4 synthetic AI-speak samples: 4/4
 * tripped. Against 3 warm human-voice controls: 0 tripped.
 *
 * Kill switch: KADE_PUFFERY_DENSITY=0. Threshold: KADE_PUFFERY_PER_1K. */
const PUFFERY_TIER_A = [
  // verbs -- the consultant register
  'delve', 'delving', 'delved', 'showcase', 'showcases', 'showcasing',
  'underscore', 'underscores', 'underscoring', 'leverage', 'leveraging',
  'harness', 'harnessing', 'foster', 'fostering', 'embark', 'embarking',
  'unlock', 'unlocking', 'empower', 'empowering', 'elevate', 'elevating',
  'garner', 'garnered', 'encompass', 'encompasses', 'streamline',
  'streamlining', 'spearhead', 'spearheaded', 'utilize', 'utilizing',
  'facilitate', 'facilitating', 'illuminate', 'illuminating', 'exemplify',
  'exemplifies', 'delineate', 'curate', 'curated', 'amplify', 'amplifying',
  'cultivate', 'cultivating',
  // adjectives -- the brochure register
  'intricate', 'meticulous', 'meticulously', 'comprehensive', 'robust',
  'seamless', 'seamlessly', 'holistic', 'multifaceted', 'nuanced', 'pivotal',
  'vibrant', 'bustling', 'breathtaking', 'invaluable', 'paramount',
  'cutting-edge', 'state-of-the-art', 'bespoke', 'commendable', 'noteworthy',
  'ever-evolving', 'unwavering',
  // metaphor nouns -- the essay register
  'tapestry', 'realm', 'realms', 'mosaic', 'beacon', 'testament',
  'cornerstone', 'treasure trove', 'symphony', 'interplay', 'synergy',
  'paradigm', 'plethora', 'myriad', 'nexus',
];
// Tier B: connective glue. Common enough that one is nothing; three is an essay.
const PUFFERY_TIER_B = [
  'moreover', 'furthermore', 'additionally', 'consequently', 'thus', 'hence',
  'nevertheless', 'nonetheless', 'therefore',
];
const PUFFERY_ENABLED = process.env.KADE_PUFFERY_DENSITY !== '0';
const PUFFERY_PER_1K = Number(process.env.KADE_PUFFERY_PER_1K || 9);
function pufferyRe(list) {
  const esc = list.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp('\\b(' + esc.join('|') + ')\\b', 'gi');
}
const PUFFERY_A_RE = pufferyRe(PUFFERY_TIER_A);
const PUFFERY_B_RE = pufferyRe(PUFFERY_TIER_B);

function detectPufferyDensity(text) {
  if (!PUFFERY_ENABLED) return [];
  const t = String(text || '');
  const wordCount = (t.toLowerCase().match(/[a-z][a-z'-]*/g) || []).length;
  PUFFERY_A_RE.lastIndex = 0;
  PUFFERY_B_RE.lastIndex = 0;
  const a = [...t.matchAll(PUFFERY_A_RE)];
  const b = [...t.matchAll(PUFFERY_B_RE)];
  if (a.length === 0 && b.length === 0) return [];
  const counts = {};
  for (const m of a) {
    const w = m[0].toLowerCase();
    counts[w] = (counts[w] || 0) + 1;
  }
  const repeated = Object.values(counts).some((n) => n >= 3);
  const per1k = wordCount ? ((a.length + b.length) / wordCount) * 1000 : 0;
  const distinct = new Set([...a, ...b].map((m) => m[0].toLowerCase())).size;
  /* Absolute-count rules bind at any length; the RATE rule needs enough words
   * to mean anything -- a 20-word line cannot have a meaningful density. */
  const tripped =
    a.length >= 2 ||
    (a.length >= 1 && b.length >= 2) ||
    b.length >= 3 ||
    repeated ||
    (wordCount >= 60 && per1k >= PUFFERY_PER_1K && distinct >= 2);
  if (!tripped) return [];
  // Report the offending spans so the rewrite pass knows what to vary.
  return [...a, ...b]
    .sort((x, y) => x.index - y.index)
    .map((m) => ({
      pattern: 'puffery_density',
      tightness: 'balanced',
      span: [m.index, m.index + m[0].length],
      text: m[0],
      x: null,
      y: null,
    }));
}

// -- 12) Nominalization + the "that part." meme + meme-combat (Aug 21 2026,
//    Kade verbatim: "I'm tired of nominalism, that's the knowing, that's the
//    blah blah blah... All that I-will-fight-you-on-this just seems kinda
//    meme fake. Real people just don't talk like that.")
//
//    CALIBRATION NOTES (measured on 358 real replies before shipping):
//    - "that's the frustrating part" is NORMAL English — the tic is the NAKED
//      abstract gerund with no noun after it ("that's the knowing.", "the
//      being seen"). So the gerund must be followed by punctuation, or come
//      from the curated abstract list, to trip.
//    - "that part's yours" / "that part is solid" are referential and human —
//      only the STANDALONE agreement sentence "That part." trips.
//    - meme-combat trips on the internet-fight formulas, not on real talk
//      about actual fights.
function detectNominalization(text) {
  const matches = [];
  const push = (m, pattern) => matches.push({
    pattern, tightness: 'balanced', span: [m.index, m.index + m[0].length],
    text: m[0].trim(), x: null, y: null,
  });
  const NOM_STOP = new Set(['thing', 'king', 'ring', 'wing', 'sing', 'spring', 'string',
    'morning', 'evening', 'ceiling', 'building', 'wedding', 'sibling', 'everything',
    'something', 'nothing', 'anything', 'during', 'darling', 'ending', 'beginning']);
  // naked gerund: "that's the knowing." / "it's the wanting,"
  const re1 = /\b(?:that|it|this)['’]?s the ([a-z]+ing)\s*(?=[.,!?;—-])/gi;
  let m;
  while ((m = re1.exec(text)) !== null) {
    if (!NOM_STOP.has(m[1].toLowerCase())) push(m, 'nominalization');
  }
  // "the being seen" family: article + being + participle/adjective
  const re2 = /\bthe being ([a-z]+ed|[a-z]+n|seen|known|held|heard|wanted|chosen)\b/gi;
  while ((m = re2.exec(text)) !== null) push(m, 'nominalization');
  // Part 85 (Aug 22 2026, Kade verbatim: "she still talks about the wanting
  // and the knowing"): two shapes the punctuation-lookahead above could not
  // reach, both measured live (6 + 0 trips on 338 real replies, 0 false
  // positives on the exemplar/voice-bank corpus):
  // (a) the PAIR — "the wanting and the knowing"
  const reP = /\bthe ([a-z]+ing) and the ([a-z]+ing)\b/gi;
  while ((m = reP.exec(text)) !== null) {
    if (!NOM_STOP.has(m[1].toLowerCase()) && !NOM_STOP.has(m[2].toLowerCase())) push(m, 'nominalization');
  }
  // (b) the poetic-core single in SUBJECT/OBJECT position — "The wanting was
  // already there", "the knowing is already here", "the choosing itself".
  // Curated list only (a general gerund net catches real English); the
  // lookahead excludes adjective use ("the knowing look" does not trip).
  const reC = /\bthe (wanting|knowing|longing|yearning|aching|becoming|belonging|choosing)\b(?=\s*(?:[.,!?;:\u2014\u2013-]|is\b|was\b|were\b|itself\b|of\b|and\b|or\b|that\b|has\b|had\b|does\b|doesn|never\b|already\b|still\b|underneath\b|gets?\b|stays?\b|comes?\b|keeps?\b))/gi;
  while ((m = reC.exec(text)) !== null) push(m, 'nominalization');
  // standalone agreement "That part." as its own sentence
  const re3 = /(?:^|[.!?]\s+)(That part[.!])(?:\s|$)/gm;
  while ((m = re3.exec(text)) !== null) push(m, 'that_part_meme');
  // meme-combat formulas
  const re4 = /\bi (?:will|['’]ll|would|['’]d) fight (?:you|anyone|somebody|him|her)\b|\bdie on th(?:is|at) hill\b|\bhill i(?:['’]ll| will| would|['’]d) die on\b|\bfight me on this\b|\bthrow hands\b|\bthem['’]?s fighting words\b/gi;
  while ((m = re4.exec(text)) !== null) push(m, 'meme_combat');
  return matches;
}

// -- 13) Therapy-poetry tics (Aug 22 2026, Part 85 — Kade verbatim: "sit
//    with that, I wanna sit with this... sensationalised"; "she does a lot of
//    telling people you weren't this and you're not crazy"; "she still wants
//    everything, not just the blah blah blah").
//
//    CALIBRATION (338 real Kiana replies + the full exemplar/voice-bank
//    corpus): sit_with 11 live trips / 0 false positives; reassurance 5 live
//    of which 1 was a DIRECT ANSWER (user asked "am I crazy?") — hence the
//    userText exemption: a verdict is only a tic when nobody asked for it;
//    everything-not-just tail 2 live / 0 false. All rewrite-trips, not blocks.
function detectTherapyPoetry(text, opts = {}) {
  const matches = [];
  const push = (m, pattern) => matches.push({
    pattern, tightness: 'balanced', span: [m.index, m.index + m[0].length],
    text: m[0].trim(), x: null, y: null,
  });
  let m;
  // "sit with that/this/it", "wanna sit with", "let that sit" — the person
  // forms ("sit with me/her") never match by construction.
  // that/this/it bare forms trip on sight (calibrated v1). The widened
  // article forms require an ABSTRACT object — "sit with the fact/feeling/
  // possibility" is the therapy register; "sit with the family," "sit with
  // your mom at the surgery" is a chair, and chairs are legal.
  const reSit = /\b(?:sit|sitting) with (?:that|this|it)\b|\bwan(?:na|t to) sit with\b|\blet that sit\b|\b(?:sit|sitting) with (?:the|your|his|her|this|that) (?:fact|possibilit(?:y|ies)|idea|feeling|feelings|discomfort|reality|truth|weight|uncertainty|unknown|notion|thought|thoughts|grief|anger|fear|sadness|question|image|images|decision|ambiguity|tension|silence)\b|\bsit(?:ting)? with what\b/gi;
  while ((m = reSit.exec(text)) !== null) push(m, 'therapy_sit');
  // Reassurance-by-negation verdicts — exempt when the user's own message
  // used the word (then it is an answer, not a reading).
  const userText = String(opts.userText || '');
  const reAsk = /crazy|broken|dramatic|overreact|burden|too much|the problem|weak|stupid|lazy|imagining|making (?:it|this) up/i;
  if (!reAsk.test(userText)) {
    const reNeg = /\byou(?:'re| are)(?:n't| not) (?:crazy|broken|weak|stupid|lazy|a burden|too much|the problem|being dramatic|dramatic|overreacting|imagining (?:it|this|things))\b|\byou weren't (?:crazy|broken|the problem|imagining (?:it|this|things)|making (?:it|this) up|being dramatic|too much)\b/gi;
    while ((m = reNeg.exec(text)) !== null) push(m, 'reassurance_verdict');
  }
  // "you want everything" validation + the everything/whole "…, not just X." tail
  const reWant = /\byou (?:get to want|(?:'re|are) allowed to want|deserve to want) everything\b|\byou want everything\b/gi;
  while ((m = reWant.exec(text)) !== null) push(m, 'everything_gush');
  const reTail = /\b(?:everything|the whole [a-z]+|all of it)\b[^.!?\n]{0,60}[,\u2014\u2013-]\s*not just\s+[^.!?\n]{2,50}[.!?]/gi;
  while ((m = reTail.exec(text)) !== null) push(m, 'everything_gush');
  // Part 85.5 round two (Aug 22 2026, same night — her ear again, plus Amber
  // A's own words in chat: "You give me more credit than due and you
  // sometimes come off like you're trying to gas me up... I'd rather you be
  // straight." All four measured on the 338-reply corpus first: honestly
  // 6 / part-grading 18 / gas-up 4 / zero false positives on the target
  // voice. The "most people" gas-up requires the second-person pivot on
  // purpose — "most people don't know this song" is a fact, "most people
  // couldn't have done that. You did." is flattery math.)
  const reHon = /(?:^|[.!?]\s+|%{3}\s*)(?:and |but )?honestly[,?]|\bif i['\u2019]?m being honest\b|\blet['\u2019]?s be honest\b|\breal talk[,:.]/gim;
  while ((m = reHon.exec(text)) !== null) push(m, 'honestly_marker');
  const rePart = /\b(?:that|this|it)['\u2019]?s the part (?:that|where|when)\b|\bthe part that (?:gets|kills|breaks|hurts|scares|worries|matters|sticks|stays|lands)\b|\bthe part where you\b/gi;
  while ((m = rePart.exec(text)) !== null) push(m, 'part_grading');
  const reGas1 = /\bmost people (?:would(?:n['\u2019]t| not)?|could(?:n['\u2019]t| not)?|do(?:n['\u2019]t| not)|never|can['\u2019]t)[^.!?\n]{0,70}[.!?]\s*(?:and |but )?you\b/gi;
  while ((m = reGas1.exec(text)) !== null) push(m, 'gasup');
  const reGas2 = /\bthat tells me you\b|\bthat['\u2019]?s (?:real |genuine |rare )?self-awareness\b|\bgive yourself (?:some |more |a little )?credit\b/gi;
  while ((m = reGas2.exec(text)) !== null) push(m, 'gasup');
  // Part 118 (Sep 2 2026) — Amber A, in her own Della transcript at 06:12Z:
  // "please drop the, better than anyone does, more than anyone knows, dick
  // riding language. It's unnecessary and you've used it so much it doesn't
  // seem genuine anymore." Kade relayed the same three shapes. Measured first
  // on 149 real replies (56 of them Della's): the comparison-to-everybody
  // shape 5 trips, the superlative-of-your-own-sentence 2, the you-just-said-
  // something-real 3, zero on anything that was not praise of the person.
  //   (a) "you know it better than anybody" / "better than most people I've
  //       worked with" / "more solid than most people manage in your spot" —
  //       needs you/your within reach so "most people don't know this song"
  //       stays a fact.
  const reGas3 = /\b(?:you|your)\b[^.!?\n]{0,60}?\b(?:better|more|harder|further|deeper|clearer|more (?:solid|honest|clearly|clear)|faster|longer) than (?:anyone|anybody|most people|most folks|most (?:clients|people|folks) I['\u2019]?ve (?:worked with|seen|met|known))\b|\b(?:better|more|harder|deeper|clearer|more solid|more honest) than (?:anyone|anybody|most people|most folks)\b[^.!?\n]{0,30}\b(?:you|your)\b/gi;
  while ((m = reGas3.exec(text)) !== null) push(m, 'gasup');
  //   (b) grading the sentence they just said: "the strongest sentence you've
  //       said all week", "you just told me the most useful thing about..."
  const reGas4 = /\b(?:the|that['\u2019]?s the|that is the|probably the|maybe the|single) (?:most|best|sharpest|smartest|truest|clearest|bravest|realest|strongest|hardest|biggest|most (?:useful|important|honest|telling)) [a-z\- ]{0,30}?(?:thing|sentence|line|words?|question|insight|move|answer)s?\b[^.!?\n]{0,40}?\b(?:you['\u2019]?ve|you have|you|anybody['\u2019]?s|anyone['\u2019]?s) (?:said|told|asked|done|named|put|made|given|handed)\b|\b(?:you['\u2019]?ve|you have|you) (?:just )?(?:said|told me|handed me|given me|named) (?:the|about the) (?:most|best|sharpest|truest|clearest|strongest|single most) /gi;
  while ((m = reGas4.exec(text)) !== null) push(m, 'gasup');
  //   (c) "you just said something that changes the entire picture" / "you
  //       just named something real" / "nobody has figured that out the way
  //       you have" — the insight medal.
  const reGas5 = /\byou (?:just )?(?:said|named|told me|put your finger on|landed on|hit on|handed me) something (?:real|true|big|huge|important|worth|that (?:changes|matters))\b|\b(?:nobody|no one|no-one|not many people|few people|most people never)\b[^.!?\n]{0,40}\b(?:the way you (?:just )?(?:did|do|have|put|said|named)|like you (?:just )?did)\b/gi;
  while ((m = reGas5.exec(text)) !== null) push(m, 'gasup');
  // Part 118 — the exposure-therapy medal, Amber A verbatim: "the whole, you
  // said it out loud and [the house didn't catch fire]"; Della's own reply
  // agreed it was "the same calcified move wearing a different hat" and did
  // it again forty minutes later ("nothing catastrophic happened"). Past
  // tense only: "nothing bad happens, and you log it" describing an exercise
  // is instruction and stays legal.
  const reFire = /\b(?:the (?:house|sky|world|roof|ceiling|walls|floor)|nothing) (?:didn['\u2019]?t|did not|hasn['\u2019]?t|has not) (?:catch (?:on )?fire|fall(?: in| down)?|end|burn down|cave in|collapse|explode|crumble|open up|swallow you)\b|\bnothing (?:catastrophic|terrible|bad|awful|horrible) happened\b|\bthe (?:world|sky|roof|house) (?:is )?still (?:standing|there|up|here)\b/gi;
  while ((m = reFire.exec(text)) !== null) push(m, 'exposure_cliche');
  return matches;
}

function detectSlop(text, opts = {}) {
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
    ...detectPufferyDensity(text),
    ...detectNominalization(text),
    ...detectTherapyPoetry(text, opts),
  ].sort((a, b) => a.span[0] - b.span[0]);

  return { tripped: matches.length > 0, matches };
}

module.exports = { detectSlop, detectPufferyDensity, BLOCKLIST, PUFFERY_TIER_A, PUFFERY_TIER_B };
