'use strict';

// These broad structures also occur in ordinary corrections and jokes.
// Keep observing them, but don't pay to rewrite a reply on this evidence alone.
// Nov 12 2026: reframe_bare_aint joins its standard twin. "That ain't love, that's control." was
// sent for rewriting while "It's not love, it's control." was only observed, so the dialect form of
// the same sentence was edited harder. KADE_AINT_TWIN=0 puts it back.
const OBSERVE_ONLY = new Set(['reframe_bare', 'isnt_reframe']);
const AINT_TWIN = 'reframe_bare_aint';

/* Nov 12 2026 — the per-character allow list. These detectors were tuned on replies that had no
 * dialect in them; several flag wording that IS a character's voice. A flag from the short set
 * below becomes an observation (logged, not sent for rewriting) when the character is allowed the
 * wording, by either of two routes the owner controls:
 *   1. KADE_VOICE_ALLOW. Unset: the built-in list below, approved Nov 12. JSON replaces it:
 *      {"Kiana":["real talk","that part"],"*":[]} (names as the persona opens, "You're Kiana";
 *      a first name matches "Harley Dalton"; "*" is everyone). KADE_VOICE_ALLOW=0 allows nothing,
 *      which is how this worked before. JSON that does not parse also allows nothing.
 *   2. opt-in, KADE_VOICE_ALLOW_PERSONA=1: the flagged words appear in that character's own
 *      persona text.
 * Nothing else is touched: the reframe family, the gush list, echo and parrot guards stay as is. */
const DEFAULT_VOICE_ALLOW = {
  Kiana: ['real talk', 'look,', 'that part', 'throw hands'],
  Harley: ['look,', 'at the end of the day'],
};
const VOICE_PATTERNS = new Set(['throat_clearing_opener', 'honestly_marker', 'that_part_meme', 'meme_combat', 'blocklist:filler_transition']);
const plain = (s) => String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z' ]+/g, ' ').replace(/\s+/g, ' ').trim();

function allowListFor(name, env) {
  try {
    const raw = env.KADE_VOICE_ALLOW;
    if (raw === '0') return [];
    const all = raw == null || raw === '' ? DEFAULT_VOICE_ALLOW : JSON.parse(raw);
    const full = String(name || '').toLowerCase(), first = full.split(' ')[0];
    const key = full && Object.keys(all).find((k) => k !== '*' && (k.toLowerCase() === full || k.toLowerCase() === first));
    return [...(Array.isArray(all['*']) ? all['*'] : []), ...(key && Array.isArray(all[key]) ? all[key] : [])].map(plain).filter(Boolean);
  } catch (_) { return []; }
}

function personaOf(body) {
  try {
    const { characterOf } = require('./register-edit');
    const sys = (body?.messages || []).find((m) => m && m.role === 'system');
    const text = typeof sys?.content === 'string' ? sys.content
      : Array.isArray(sys?.content) ? sys.content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n') : '';
    const cut = text.indexOf('## Voice performance v2');
    return { name: characterOf(body).name, text: plain(cut > 0 ? text.slice(0, cut) : text) };
  } catch (_) { return { name: '', text: '' }; }
}

function voiceLicensed(match, persona, allow, env) {
  if (!VOICE_PATTERNS.has(match.pattern)) return false;
  const said = plain(match.text);
  if (said.length < 4) return false;
  if (allow.some((a) => said.includes(a) || a.includes(said))) return true;
  return env.KADE_VOICE_ALLOW_PERSONA === '1' && said.includes(' ') && persona.text.includes(said);
}

function conversationalRewriteMatches(matches, body, env = process.env) {
  if (env.KADE_CONVERSATION_STYLE_OBSERVE === '0') return matches;
  const aintTwin = env.KADE_AINT_TWIN !== '0';
  const persona = body ? personaOf(body) : { name: '', text: '' };
  const allow = body ? allowListFor(persona.name, env) : [];
  return matches.filter((match) => {
    if (OBSERVE_ONLY.has(match.pattern)) return false;
    if (aintTwin && match.pattern === AINT_TWIN) return false;
    if (body && voiceLicensed(match, persona, allow, env)) return false;
    return true;
  });
}
module.exports = { conversationalRewriteMatches, VOICE_PATTERNS, DEFAULT_VOICE_ALLOW };
