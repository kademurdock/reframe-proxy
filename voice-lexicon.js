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

const norm = (s) => String(s || '').replace(/[‘’ʼ]/g, "'").replace(/%%%[^%\n]*%%%/g, ' ');

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

/* Grammar a word list cannot see. Each is a real spoken pattern with a standard twin. */
const GRAMMAR = [
  ['g-drop', /\b[a-z]{2,}in'(?![a-z])/g],                              // talkin', nothin'
  ['subj-dont', /\b(?:he|she|it|that)\s+don't\b/g],                    // he don't
  ['was-level', /\b(?:we|they|you)\s+was\b/g],                         // they was
  ['done-perf', /\bdone\s+(?:\w+ed|told|gone|went|got|lost|seen|took|made|said|did)\b/g],
  ['neg-concord', /\b(?:ain't|don't|can't|won't|didn't|never)\s+(?:\w+\s+){0,2}(?:no|nothing|nothin'|nobody|none|nowhere)\b/g],
  ['zero-copula', /\b(?:you|we|they)\s+(?:good|right|wrong|crazy|trippin'?|wild|funny|riding|coming|going|playing|lying)\b/g],
  ['plain-third', /(?<!\b(?:does|did|do|will|would|can|could|should|might|must|to|let|make|made|see|saw|hear|heard|watch|help|have|had)\s)\b(?:he|she|it)\s+(?:know|look|think|want|need|say|go|make|take|talk|act)\b(?!\s+(?:like|as if)\b)/g], // he know
  ['no-copula', /(?<!\b(?:are|is|was|were|am|be|been|see|saw|hear|heard|watch|got|get|keep|kept|of|with|about|for|on|at|by|from|like|than|and|or|if|when|while|before|after|without)\s)\b(?:he|she|they|we|you|folks)\s+(?:finna|tryna|[a-z]{3,}ing\b|[a-z]{3,}in')/g], // he doing
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
    if (DIALECT_SET.has(w) || DIALECT_SET.has(bare)) out.push({ t: DIALECT_SET.has(w) ? w : bare, cls: 'dialect', at: m.index });
    else if (SWEAR_SET.has(bare)) out.push({ t: bare, cls: 'swear', at: m.index });
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
 * @returns {string} '' when fine, otherwise the lost token (for the log)
 */
function voiceLoss(before, after) {
  if (!after || !String(after).trim()) return '';
  const b = voiceTokens(before);
  if (!b.length) return '';
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

module.exports = { voiceTokens, voiceLoss, ticAdded, ticsOf, licensedWords, guardOn, norm, DIALECT, SWEAR, INTERJECTION };
