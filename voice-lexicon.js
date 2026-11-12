'use strict';
/* Nov 12 2026 — THE VOICE LEXICON. Kade: "that half black hardly EVER shows up ... These chars
 * need to be synthetic souls, conversation partners. Not textbooks."
 *
 * This file writes nothing a character says. It only RECOGNISES spoken, non-standard and personal
 * wording in text that already exists, so that (a) an editor cannot quietly translate it into
 * standard English (voiceLoss) and (b) a log line can count it (voice-meter.js). It is a list of
 * forms, not a list per character: which of them belong to a character is read from that
 * character's own persona text (licensedWords), so the owner's persona stays the only authority.
 *
 * Pure, no I/O, no model call. */

/* A run of blank space becomes one character (a newline if it held one). The patterns below let a
 * sentence start "after a stop and any blank space", and on a reply stuck printing newlines that
 * cost seconds of event loop: 3 s for 20,000 of them (review, Nov 12). Positions are read off the
 * same normalised text everywhere in this file. */
const norm = (s) => String(s || '').replace(/[‘’ʼ]/g, "'").replace(/%%%[^%\n]*%%%/g, ' ')
  .replace(/\s{2,}/g, (run) => (run.includes('\n') ? '\n' : ' '));

/* Spoken and dialect forms that have a standard-English twin an editor could swap in. */
const DIALECT = [
  "ain't", 'finna', 'gonna', 'gotta', 'wanna', 'tryna', 'imma', "i'ma", "i'mma", 'lemme', 'gimme',
  "y'all", "y'all's", "ya'll", 'yall', 'kinda', 'sorta', 'dunno', 'cuz', "'cause", "'em", "'bout",
  "'til", 'outta', 'lotta', 'coulda', 'woulda', 'shoulda', 'musta', 'oughta', 'nah', 'naw', 'yep',
  'yup', 'nope', 'yo', 'hella', 'hellas', 'reckon', 'yonder', "ol'", "lil'", 'lil', "fixin'",
  'fixin', 'bruh', 'sis', 'chile', 'ion', 'tho', 'aight', "a'ight", 'whatcha', 'gotcha', 'betcha',
  'innit', 'mighty', 'plumb', 'ornery', 'holler', 'hollerin', 'young\'un', "young'uns", 'kin',
];
const SWEAR = [
  'damn', 'damned', 'goddamn', 'dammit', 'hell', 'shit', 'shitty', 'bullshit', 'fuck', 'fucking',
  "fuckin'", 'fuckin', 'fucked', 'ass', 'asshole', 'bitch', 'crap', 'pissed', 'dang', 'heck',
  'shoot', 'darn', 'friggin', 'freakin',
];
/* Counted only at the head of a sentence, before a comma or other pause. */
const INTERJECTION = [
  'lord', 'lawd', 'whew', 'chile', 'mercy', 'shoot', 'girl', 'boy', 'man', 'baby', 'hoo', 'hoo boy',
  'mm-mm', 'mm-hm', 'mhm', 'uh-uh', 'uh-huh', 'welp', 'sheesh', 'psh', 'pfft', 'ha', 'oof', 'ope',
  'bless', 'look here', 'now see', 'see now', 'listen here',
];
const DIALECT_SET = new Set(DIALECT), SWEAR_SET = new Set(SWEAR), INTERJ_SET = new Set(INTERJECTION);

/* Grammar a word list cannot see. Each is a real spoken pattern with a standard twin.
 * Review, Nov 12: three of these read standard English as dialect, and the guard then refused a
 * plain cut. "Where are you going to stay?" is not a dropped "are" (HELPED: a verb or preposition
 * that takes "you" as its object, or the helper of a question), "Doesn't he know?" is not a
 * dropped -s (AFTER_NT), "call you right back" is not "you right", and "tell you something" is
 * not a dropped "are" (ING_NOUN: words in -ing that are not verbs). */
const HELPED = "(?<!\\b(?:are|is|was|were|am|be|been|being|do|does|did|done|doing|see|saw|seen|hear|heard|watch|watched|got|get|gets|getting|keep|keeps|kept|have|has|had|having|make|makes|made|making|drive|drives|drove|driving|serve|serves|served|tell|told|want|wants|wanted|need|needs|find|found|leave|left|catch|caught|of|with|about|for|on|at|by|from|like|than|without|to)\\s)";
const AFTER_NT = "(?<![a-z]n't\\s)";
const ING_NOUN = "(?!(?:some|any|no|every)thin[g']|(?:during|darling|morning|evening|string|spring)\\b)";
const GRAMMAR = [
  ['g-drop', /\b[a-z]{2,}in'(?![a-z])/g],                              // talkin', nothin'
  ['subj-dont', /\b(?:he|she|it|that)\s+don't\b/g],                    // he don't
  ['was-level', /\b(?:we|they|you)\s+was\b/g],                         // they was
  ['done-perf', /\bdone\s+(?:\w+ed|told|gone|went|got|lost|seen|took|made|said|did)\b/g],
  ['neg-concord', /\b(?:ain't|don't|can't|won't|didn't|never)\s+(?:\w+\s+){0,2}(?:no|nothing|nothin'|nobody|none|nowhere)\b/g],
  ['zero-copula', new RegExp(HELPED + AFTER_NT + "\\b(?:you|we|they)\\s+(?:good|right(?!\\s+(?:now|back|there|here|away|after|before|then|when|where|behind|next|over|up|down|off|out|on|at|in|by)\\b)|wrong|crazy|trippin'?|wild|funny|riding|coming|going|playing|lying)\\b", 'g')],
  ['plain-third', new RegExp("(?<!\\b(?:does|did|do|will|would|can|could|should|might|must|to|let|make|made|see|saw|hear|heard|watch|help|have|had)\\s)" + AFTER_NT + "\\b(?:he|she|it)\\s+(?:know|look|think|want|need|say|go|make|take|talk|act)\\b(?!\\s+(?:like|as if)\\b)", 'g')], // he know
  ['no-copula', new RegExp("(?<!\\b(?:are|is|was|were|am|be|been|see|saw|hear|heard|watch|got|get|keep|kept|of|with|about|for|on|at|by|from|like|than|and|or|if|when|while|before|after|without)\\s)" + AFTER_NT + "\\b(?:he|she|they|we|you|folks)\\s+" + ING_NOUN + "(?:finna|tryna|[a-z]{3,}ing\\b|[a-z]{3,}in')", 'g')], // he doing
  ['habitual-be', /\b(?:he|she|they|we|you|it|folks|people)\s+(?:still\s+)?be\s+[a-z]{3,}in[g']/g],                 // they be arguing
  ['double-modal', /\b(?:might|may|used to)\s+(?:could|can|should|would)\b/g],                                        // might could
  ['them-dem', /\bthem\s+(?:boys|girls|folks|people|kids|dogs|things|days|shoes|cows|beans|biscuits)\b/g],
];

const WORD_RE = /'?[a-z][a-z'-]*/g;

/**
 * Every voice token in a stretch of text, in order.
 * @returns {{t:string, cls:'dialect'|'swear'|'interjection'|'grammar', at:number}[]}
 */
function voiceTokens(text) {
  const s = norm(text).toLowerCase();
  const out = [];
  for (const m of s.matchAll(WORD_RE)) {
    const w = m[0].replace(/^-+|-+$/g, '');
    const bare = w.replace(/^'/, '');
    // "shit's broken" still says "shit" and "y'all're" still says "y'all" (review, Nov 12)
    const root = bare.replace(/'(?:s|d|ll|re|ve)$/, '');
    const dialect = DIALECT_SET.has(w) ? w : DIALECT_SET.has(bare) ? bare : DIALECT_SET.has(root) ? root : '';
    if (dialect) out.push({ t: dialect, cls: 'dialect', at: m.index });
    else if (SWEAR_SET.has(bare) || SWEAR_SET.has(root)) out.push({ t: SWEAR_SET.has(bare) ? bare : root, cls: 'swear', at: m.index });
  }
  for (const m of s.matchAll(/(?:^|[.!?\n]\s*|^\s*)((?:[a-z][a-z-]*)(?:\s[a-z]+)?)(?=\s*[,!…—-])/g)) {
    const w = m[1];
    const first = w.split(' ')[0];
    const hit = INTERJ_SET.has(w) ? w : INTERJ_SET.has(first) ? first : '';
    if (hit) out.push({ t: hit, cls: 'interjection', at: m.index + m[0].length - w.length });
  }
  for (const [name, re] of GRAMMAR) {
    re.lastIndex = 0;
    for (const m of s.matchAll(re)) out.push({ t: name, cls: 'grammar', at: m.index, text: m[0] });
  }
  return out.sort((a, b) => a.at - b.at);
}

/* The standard twin of a spoken form. A lost token whose twin newly appears was translated. */
const TWINS = {
  "ain't": ["isn't", "is not", "aren't", "are not", "am not", "haven't", "hasn't", "have not", "has not", "'s not", "'re not", "'m not", "didn't", "did not"],
  finna: ["going to", "about to"], gonna: ["going to"], wanna: ["want to"], gotta: ["got to", "have to", "need to"],
  "y'all": ["you all", "you guys"], nah: ["no"], naw: ["no"], nope: ["no"], yep: ["yes"], yup: ["yes"],
  "'em": ["them"], lemme: ["let me"], gimme: ["give me"], tryna: ["trying to"], outta: ["out of"],
  kinda: ["kind of"], sorta: ["sort of"], dunno: ["don't know", "do not know"], cuz: ["because"], "'cause": ["because"],
  imma: ["i'm going to", "i will", "i'll"], "i'ma": ["i'm going to", "i will", "i'll"],
  reckon: ["think", "guess", "suppose", "figure"], hella: ["very", "really"], "subj-dont": ["doesn't", "does not"],
  "was-level": ["were"], "g-drop": ["ing"],
};
/* Twin phrases hold only letters, spaces and apostrophes, so they need no regex escaping. */
const countOf = (text, phrase) => phrase === 'ing'
  ? (text.match(/[a-z]{2,}ing\b/g) || []).length
  : (text.match(new RegExp((/^[a-z]/.test(phrase) ? "(?:^|[^a-z'])" : '') + phrase + "(?![a-z'])", 'g')) || []).length;

const stem = (w) => w.replace(/'/g, '').slice(0, 5);
function contentStems(text) {
  return new Set((norm(text).toLowerCase().match(/[a-z][a-z']+/g) || []).filter((w) => w.replace(/'/g, '').length >= 4).map(stem));
}

/* Was a whole clause cut and the rest left exactly as it was? The replacement must sit in the
 * original as one piece (capitals and its closing stop aside). Each side that went must be a
 * clause: three words or more, with a subject and verb of its own, closed by a comma or other
 * stop. Between that stop and what stays only joining words may go ("and", "it's that"). So
 * "Lord, that boy can eat." -> "That boy can eat." is not a clause cut (one word went), nor is
 * "What the hell, man, you can't just leave." -> "You can't just leave." (a lead-in, no subject
 * and verb), nor "I get it, that damn dog barks." -> "Dog barks." ("that damn" is not a joining
 * word), nor "a damn fool" -> "a fool" (not one piece). Those go on to the token test below. */
const CLAUSE_SIGN = /\b(?:i|he|she|it|that|this|you|we|they|there|y'all|folks)\s+[a-z']+|[a-z]n't\b|[a-z]'(?:s|re|m|d|ll|ve)\b/;
const JOINING = new Set(['and', 'but', 'so', 'or', 'because', "'cause", 'cause', 'cuz', "it's", 'its', 'it', 'is', 'that', "that's", 'then', 'just', 'though']);
const wordsOf = (s) => s.match(/'?[a-z][a-z'-]*/g) || [];
const STOP = ',;:.!?…—';
function wentWhole(clause, joint) {
  const joining = wordsOf(joint);
  return wordsOf(clause).length >= 3 && CLAUSE_SIGN.test(clause) && joining.length <= 3 && joining.every((w) => JOINING.has(w));
}
function clauseCut(before, after) {
  const b = norm(before).toLowerCase().trim();
  const a = norm(after).toLowerCase().trim().replace(/[\s.!?…,;:—-]+$/, '');
  if (!a) return false;
  for (let k = b.indexOf(a); k >= 0; k = b.indexOf(a, k + 1)) {
    const left = b.slice(0, k), right = b.slice(k + a.length);
    if (/[a-z'-]$/.test(left) || /^[a-z'-]/.test(right)) continue; // inside a word
    const cutLeft = wordsOf(left).length > 0, cutRight = wordsOf(right).length > 0;
    if (!cutLeft && !cutRight) return false; // nothing was cut
    const l = left.match(new RegExp('^([^]*[' + STOP + '])([^' + STOP + ']*)$'));
    const r = right.match(new RegExp('^([^' + STOP + ']*)([' + STOP + '][^]*)$'));
    if ((!cutLeft || (l && wentWhole(l[1], l[2]))) && (!cutRight || (r && wentWhole(r[2], r[1])))) return true;
  }
  return false;
}

/**
 * Did this edit TRANSLATE voice, as opposed to cutting it?
 *
 * An editor may cut: when a whole clause goes ("That dog ain't deaf, hon, he's negotiatin'." ->
 * "He's negotiatin', hon."), the "ain't" went with its clause and nothing was translated. What it
 * may not do is keep the words around a voice token and lose the token: "She finna be unbearable"
 * -> "She's going to be unbearable", "a damn fool" -> "a fool", "Lord, that boy can eat." ->
 * "That boy can eat." The test is local and deterministic: a token is lost when the replacement
 * has fewer of it, and it was translated when the next word of four letters or more that followed
 * it (or, at the end of a sentence, the one before it) is still in the replacement.
 *
 * That test alone misread the commonest cut of all (review, Nov 12): a contrast whose halves are
 * built alike. "It ain't about the money, it's about respect." -> "It's about respect." keeps
 * "about", so the lost "ain't" looked translated and her most named peeve stayed in the reply.
 * clauseCut settles it first: when the replacement is one unbroken piece of the original, word
 * for word, and each side that went is a whole clause, nothing was translated.
 *
 * @returns {string} '' when fine, otherwise the lost token (for the log)
 */
function voiceLoss(before, after) {
  if (!after || !String(after).trim()) return '';
  const b = voiceTokens(before);
  if (!b.length) return '';
  if (clauseCut(before, after)) return '';
  const pool = voiceTokens(after).map((x) => x.t);
  const afterStems = contentStems(after);
  const src = norm(before).toLowerCase();
  for (const tok of b) {
    const i = pool.indexOf(tok.t);
    if (i >= 0) { pool.splice(i, 1); continue; }
    const lowAfter = norm(after).toLowerCase();
    if ((TWINS[tok.t] || []).some((p) => countOf(lowAfter, p) > countOf(src, p))) return tok.t;
    const own = new Set((tok.text || tok.t).match(/[a-z][a-z']+/g) || []);
    const words = [...src.matchAll(/[a-z][a-z']+/g)].map((m) => ({ w: m[0], at: m.index }))
      .filter((x) => x.w.replace(/'/g, '').length >= 4 && !own.has(x.w));
    const next = words.find((x) => x.at > tok.at) || [...words].reverse().find((x) => x.at < tok.at);
    if (next && afterStems.has(stem(next.w))) return tok.t;
  }
  return '';
}

/* House tics an editor must never ADD. Not a ban on the words: a reply that already says
 * "honestly" keeps it. Kade, Nov 12: "it's not like I have a problem with using the word
 * honestly, it's this pattern". An editor that inserts it is making the pattern. */
const TIC_RE = /\bhonestly\b|\bnot nothing\b|\bain't nothing\b(?=[.!,]|$)|\bhere's the thing\b|\bthat's the (?:thing|whole \w+)\b|\bat the end of the day\b|\bfull stop\b|\bto be fair\b/g;
const ticsOf = (t) => (norm(t).toLowerCase().match(TIC_RE) || []);
function ticAdded(before, after) {
  const have = ticsOf(before);
  for (const t of ticsOf(after)) {
    const i = have.indexOf(t);
    if (i < 0) return t;
    have.splice(i, 1);
  }
  return '';
}

/* The words this character's own persona text uses or names: the per-character licence. */
function licensedWords(personaText) {
  return [...new Set(voiceTokens(personaText).filter((x) => x.cls !== 'grammar').map((x) => x.t))];
}

const guardOn = (env = process.env) => env.KADE_VOICE_GUARD !== '0';

module.exports = { voiceTokens, voiceLoss, clauseCut, ticAdded, ticsOf, licensedWords, guardOn, norm, DIALECT, SWEAR, INTERJECTION };
