'use strict';

/* voice-meter.js -- COUNTS how much of a character's own way of talking is in a reply. Never edits.
 *
 * Nov 12 2026. Every test in the record scored essay shapes, length or a blind preference. Nobody
 * has ever counted the thing she is asking about now: does Kiana's grammar, Harley's grammar, a
 * swear, a stated position show up at all. Without that number no change to voice can be told
 * from noise, and the record's rule is to measure on her real replies before calling anything a fix.
 *
 * The kinds are grammar and word features, not topics: no food, church or porch words, so a reply
 * about cornbread in standard English scores zero and a reply about tax law in her own grammar
 * scores. It is a floor, not a judge: it cannot hear rhythm or wit. Log: [voice-meter].
 * Kill switch: KADE_VOICE_METER=0. */

const TAG_RE = /%{3}[^%]*%{3}/g;
const AUX = '(?:are|is|was|were|am|be|been|do|does|did|have|has|had|will|would|can|could|should|might|must|to|let|see|saw|hear|heard|watch|watched|got|get|keep|kept|of|with|about|for|on|at|by|from|like|than|and|or|if|when|while|before|after|without)';

const NOT_NOUN = '(?!(?:always|this|is|was|has|does|unless|across|perhaps|sometimes|besides|yes|less|its|his|as|us|plus|thanks)\\b)';

/* Each: [kind, regex, group]. group: g = grammar, w = word choice, s = swear, o = own opinion. */
const KINDS = [
  ['aint', /\bain['’]?t\b/gi, 'g'],
  ['yall', /\by['’]all\b/gi, 'g'],
  ['finna_tryna', /\b(?:finna|tryna|gon['’]|bout to|'bout to)\b/gi, 'g'],
  ['fixin_to', /\bfixin['’g]? to\b/gi, 'g'],
  ['dropped_g', /\b[a-z]{2,}in['’](?![a-z])/gi, 'g'],
  // "he know", "it look", "the dollar buy": third person without the s, for a short list of common verbs
  ['plain_third', new RegExp('(?<!\\b' + AUX + '\\s)\\b(?:he|she|it|that man|that dude)\\s+(?:know|look|think|want|need|say|got|get|go|make|take|talk|act|do)\\b(?!\\s+(?:like|as if)\\b)', 'gi'), 'g'],
  // "you finna", "he trippin", "they working": no is/are before the verb
  ['no_copula', new RegExp('(?<!\\b' + AUX + '\\s)\\b(?:he|she|they|we|you|who|folks)\\s+(?:finna|tryna|trippin[g\'’]?|gon[\'’]|[a-z]{3,}ing\\b|[a-z]{3,}in[\'’])', 'gi'), 'g'],
  ['habitual_be', /\b(?:he|she|they|we|you|it|folks|people|scientists)\s+(?:still\s+)?be\s+[a-z]{3,}in[g'’]/gi, 'g'],
  ['double_neg', /\b(?:ain['’]?t|don['’]?t|can['’]?t|won['’]?t|didn['’]?t|never)\s+(?!say\b)(?:[a-z'’]+\s+){0,3}(?:no|nothing|nothin['’]?|nobody|none|nowhere)\b/gi, 'g'],
  ['was_dont', /\b(?:they|we|you)\s+was\b|\b(?:he|she|it)\s+don['’]t\b/gi, 'g'],
  ['done_verb', /\bdone\s+(?:[a-z]{2,}ed|told|seen|gone|went|did|had|got|said|lost|made|took)\b/gi, 'g'],
  // "them cable ends", "them particular folks": them for those, after a clause break or a preposition
  ['them_those', new RegExp('(?:^|[.!?,;]\\s+|\\b(?:of|with|in|on|for|about|at|by|like|and|all|is|are|or)\\s+)them\\s+(?:' + NOT_NOUN + '[a-z]+\\s+)?' + NOT_NOUN + '(?:[a-z]{3,}s|folks|people)\\b', 'gi'), 'g'],
  ['might_could', /\bmight could\b|\bused to could\b/gi, 'g'],
  ['country_words', /\b(?:reckon|yonder|holler|fella|feller|oughta|ought to|how come|a ways|liable to|every which way|come (?:january|spring|morning|sunday))\b/gi, 'w'],
  ['street_words', /\b(?:nah|naw|yo|hella|aight|for real|lowkey|on everything)\b/gi, 'w'],
  ['interjection', /(?:^|[.!?]\s+|\n)\s*(?:lord|shoot|whew|dang|aw|well now)\b/gi, 'w'],
  ['swear', /\b(?:fuck\w*|shit\w*|bullshit|goddamn\w*|damn|hell|ass|asses|[a-z]+-ass)\b/gi, 's'],
  ['own_position', /\b(?:i think|i don['’]?t (?:buy|think|trust|like)|i ain['’]?t (?:buying|with|saying)|i['’]?d (?:vote|rather|be at|go with|say|tell (?:him|her|them))|i come down|i do\.|i disagree|my (?:take|vote|money['’]?s on)|i['’]?m (?:for|against|with)\b|if you ask me)/gi, 'o'],
];

function measure(text) {
  const plain = String(text || '').replace(TAG_RE, ' ');
  const words = (plain.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
  const kinds = {};
  const sum = { g: 0, w: 0, s: 0, o: 0 };
  for (const [kind, re, group] of KINDS) {
    const n = (plain.match(re) || []).length;
    if (n) { kinds[kind] = n; sum[group] += n; }
  }
  const per100 = (n) => (words ? Math.round((n / words) * 1000) / 10 : 0);
  return {
    words,
    grammar: sum.g, wordChoice: sum.w, swears: sum.s, positions: sum.o,
    dialectPer100: per100(sum.g + sum.w),
    kinds,
  };
}

function logLine(reqId, who, lane, text, extra = {}) {
  const m = measure(text);
  return `[voice-meter] ${JSON.stringify({ req: reqId, who: who || '?', lane, ...extra, words: m.words, dialectPer100: m.dialectPer100, grammar: m.grammar, wordChoice: m.wordChoice, swears: m.swears, positions: m.positions, kinds: m.kinds })}`;
}

const meterOn = (env = process.env) => String(env.KADE_VOICE_METER ?? '1') !== '0';

module.exports = { measure, logLine, meterOn, KINDS };
