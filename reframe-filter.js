/**
 * reframe-filter.js
 *
 * Deterministic detector for the "it's not X, it's Y" rhetorical reframe tic
 * (and its cousins). No LLM judge — pure regex/string matching, so it's cheap
 * enough to run on every model response. A trip is meant to *trigger a rewrite
 * pass*, not hard-block output, so the default tightness leans slightly
 * aggressive on purpose.
 *
 * Verbatim copy of the reference module kept in the project's iCloud folder
 * (reframe-filter.js) — keep both in sync by hand if this is ever revised.
 */

'use strict';

const LEVEL_RANK = { strict: 1, balanced: 2, aggressive: 3 };

const SUBJ = "(?:it|that|this|these|those)";
const COP  = "(?:'s|’s|s| is| are)?";
const COP2 = "(?:'s|’s|s| is| are| ain't| ain’t| aint)";
const EMPH = "(?:just|merely|simply|only)";
const ART  = "(?:a|an|the)";
const SEP  = "(?:\\s*[,\\u2014\\u2013:;]\\s*|\\.\\s+)";
const RUN  = "[^,.;:!?\\u2014\\u2013]+?";
const RUN_END = "[^.;:!?\\u2014\\u2013]+?";

const DETECTORS = [
  // Aug 15 2026 (Part 70.5, Kade reading Amber's logs): two shapes measured
  // slipping through on live family chat — the BARE pivot with no emphasis
  // word ("That's not concern, that's control.") and the SECOND-PERSON pivot
  // ("You weren't standing, you were standing back..."), which was literally
  // her quoted example. Both are rewrite-trips, not blocks, so leaning
  // aggressive matches her explicit "absolutely cannot stand" verdict.
  {
    pattern: 'reframe_bare',
    tightness: 'balanced',
    xy: [2, 4],
    re: new RegExp(
      `\\b(${SUBJ})${COP2}\\s+not\\s+(${RUN})${SEP}(${SUBJ})${COP2}\\s+(?:${ART}\\s+)?(${RUN_END})\\s*[.!?]`,
      'gi'
    ),
  },
  {
    // "that ain't X. That's just Y" — ain't carries its own negation, so the
    // bare-pivot pattern's separate "not" never matches the dialect form.
    pattern: 'reframe_bare_aint',
    tightness: 'balanced',
    xy: [2, 4],
    re: new RegExp(
      `\\b(${SUBJ})\\s+ain['’]?t\\s+(?:${EMPH}\\s+)?(${RUN})${SEP}(${SUBJ})${COP2}\\s+(?:${EMPH}\\s+)?(?:${ART}\\s+)?(${RUN_END})\\s*[.!?]`,
      'gi'
    ),
  },
  {
    pattern: 'reframe_second_person',
    tightness: 'balanced',
    xy: [2, 3],
    re: /\b(?:you|she|he|they|we)\s+(?:(?:were|was|are|is|do|does|did)\s*n[o'\u2019]t|ain['\u2019]?t)\s+(?:just\s+)?([^,.;:!?]{2,60}),\s*(?:you|she|he|they|we)\b([^.!?]{2,90})[.!?]/gi,
  },
  {
    pattern: 'reframe_emphatic',
    tightness: 'strict',
    xy: [2, 4],
    re: new RegExp(
      `\\b(${SUBJ})${COP}\\s+(?:is\\s+)?not\\s+${EMPH}\\s+(${RUN})${SEP}(${SUBJ})${COP2}\\s+(?:${EMPH}\\s+)?(?:${ART}\\s+)?(${RUN_END})\\s*[.!?]`,
      'gi'
    ),
  },
  {
    pattern: 'reframe_article',
    tightness: 'strict',
    xy: [2, 4],
    re: new RegExp(
      `\\b(${SUBJ})${COP}\\s+(?:is\\s+)?not\\s+(?:${EMPH}\\s+)?${ART}\\s+(${RUN})${SEP}(${SUBJ})${COP2}\\s+(?:${EMPH}\\s+)?(?:${ART}\\s+)?(${RUN_END})\\s*[.!?]`,
      'gi'
    ),
  },
  {
    pattern: 'isnt_reframe',
    tightness: 'balanced',
    xy: [2, 4],
    re: new RegExp(
      `\\b([\\w'\\u2019]+(?:\\s+[\\w'\\u2019]+){0,3})\\s+(?:isn't|isn\\u2019t|aren't|aren\\u2019t|is not|are not)\\s+(?:${EMPH}\\s+|${ART}\\s+)(${RUN})${SEP}(${SUBJ})${COP2}\\s+(?:${EMPH}\\s+)?(?:${ART}\\s+)?(${RUN_END})\\s*[.!?]`,
      'gi'
    ),
  },
  {
    pattern: 'isnt_just',
    tightness: 'balanced',
    xy: [2, null],
    re: new RegExp(
      `\\b([\\w'\\u2019]+(?:\\s+[\\w'\\u2019]+){0,3})\\s+(?:isn't|isn\\u2019t|aren't|aren\\u2019t|is not|are not)\\s+${EMPH}\\s+(${RUN})${SEP}`,
      'gi'
    ),
  },
  {
    pattern: 'not_x_but_y_cued',
    tightness: 'balanced',
    xy: [1, 2],
    re: new RegExp(
      `\\bnot\\s+(?:${EMPH}\\s+|${ART}\\s+)(${RUN})\\s+but\\s+(?:rather\\s+)?(?:${ART}\\s+)?(${RUN})\\s*[.!?,;:]`,
      'gi'
    ),
  },
  {
    pattern: 'reframe_bare',
    tightness: 'aggressive',
    xy: [2, 4],
    re: new RegExp(
      `\\b(${SUBJ})${COP}\\s+(?:is\\s+)?not\\s+(${RUN})${SEP}(${SUBJ})${COP2}\\s+(${RUN_END})\\s*[.!?]`,
      'gi'
    ),
  },
  {
    pattern: 'not_x_but_y_bare',
    tightness: 'aggressive',
    xy: [1, 2],
    re: new RegExp(
      `\\bnot\\s+(${RUN})\\s+but\\s+(?:rather\\s+)?(${RUN})\\s*[.!?,;:]`,
      'gi'
    ),
  },
];

function detect(text, options = {}) {
  const level = options.level || 'balanced';
  const activeRank = LEVEL_RANK[level];
  if (!activeRank) {
    throw new Error(`Unknown tightness level: ${level} (use strict|balanced|aggressive)`);
  }

  const matches = [];
  const seenSpans = new Set();

  for (const det of DETECTORS) {
    if (LEVEL_RANK[det.tightness] > activeRank) continue;
    det.re.lastIndex = 0;
    let m;
    while ((m = det.re.exec(text)) !== null) {
      if (m.index === det.re.lastIndex) det.re.lastIndex++;

      const start = m.index;
      const end = m.index + m[0].length;
      const key = `${start}:${end}`;
      if (seenSpans.has(key)) continue;
      seenSpans.add(key);

      const [xi, yi] = det.xy;
      matches.push({
        pattern: det.pattern,
        tightness: det.tightness,
        span: [start, end],
        text: m[0].trim(),
        x: xi != null && m[xi] ? m[xi].trim() : null,
        y: yi != null && m[yi] ? m[yi].trim() : null,
      });
    }
  }

  matches.sort((a, b) => a.span[0] - b.span[0]);
  return { tripped: matches.length > 0, level, matches };
}

function inspectResponse(text, options = {}) {
  const result = detect(text, options);
  return {
    ...result,
    offendingSpans: result.matches.map((m) => m.text),
  };
}

module.exports = { detect, inspectResponse, DETECTORS };
