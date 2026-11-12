'use strict';

/* voice-reel.js -- the character's own voice as conversation turns, and as the last words of the tail.
 *
 * Nov 12 2026. Her words: "These chars need to be synthetic souls, conversation partners. Not
 * textbooks ... Kiana ... half black, half white girl, and that half black hardly EVER shows up."
 *
 * What the record says (ai-tells-and-prompt-weight, register-edit-oct18, voice_register_2026-09-25):
 * notes about how to talk do not move the register on MiMo; a model continues what it is shown.
 * Every earlier example lived INSIDE a system message (the "Them:/You:" block, the eight anchor
 * lines, two voice samples), where the model reads it as a rule about a script and copies the
 * content when the topic matches. Nothing has ever shown a character its own voice in the place a
 * model actually continues from: assistant-role turns in the conversation itself.
 *
 * Two pieces, each with its own switch, both off unless switched on:
 *
 *   THE REEL   KADE_VOICE_REEL=1. A few short exchanges, picked per conversation from an
 *              owner-approved pool of at least 12, ride as real user/assistant turns between the
 *              system head and the real history. Chosen by a hash of the conversation's first
 *              message, so one conversation carries the same reel from turn to turn and two
 *              conversations carry different ones (no single line can become a tic).
 *              A line whose subject overlaps what the person just said sits that turn out: the
 *              recorded failure is content copy on a topic match.
 *              COST, to settle before this is ever switched on (review, Nov 12): the reel sits
 *              right after the system head, so on a turn where a line sits out, and on the turn
 *              after it, everything behind the head is billed uncached. The prefix holds only on
 *              turns whose reel is the same as the turn before.
 *
 *   THE CARD   KADE_VOICE_CARD=1. About 80 words in the character's own first person and grammar,
 *              as the very last words of the gateway tail, after the talk note. It holds no sample
 *              reply and no subject matter, so there is nothing topical to copy; the text itself is
 *              the demonstration.
 *
 * The reel is decided right after appendReminder (server.js withCharacterVoice, where the machine
 * lanes are already carved out) and stored on the body under a Symbol. It is spliced into the
 * messages only at the two JSON.stringify calls that send a body upstream, so every detector, the
 * think router, cadence drift and reply focus go on reading the real conversation. The two
 * OpenRouter fallback sends do not splice it, so a fallback turn goes without. Nothing is stored
 * in Mongo; nothing reaches memory or compaction.
 *
 * SHIPPED OFF (Nov 12 2026). This is plumbing only: both switches are unset, both pools in
 * ./voice-reel are drafts with "approved": false, and no line reaches a model until she approves
 * a pool's wording AND the switch is set. Typed turns only: a call has no parrot check, so a phone
 * turn goes without the reel unless KADE_VOICE_REEL_CALLS=1 is set as well.
 *
 * Pools live in ./voice-reel/<id>.json. A pool rides only when "approved": true (her word on her
 * characters' wording). KADE_VOICE_REEL_DRAFTS=1 lets drafts ride, for the offline harness only.
 * Lines marked "salty" ride only when the head carries the adult audience note; a child-typed or
 * untyped turn gets clean lines only. The card is held clean by test.
 * Fail-safe: anything throws -> the body goes on unchanged. */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REEL = Symbol.for('kade.voiceReel');
const POOL_DIR = path.join(__dirname, 'voice-reel');
const MIN_POOL = 12;
const DEFAULT_PAIRS = 4;
const SOL_MODEL_RE = /^(?:openai\/)?gpt-6\.1-sol(?:-\d{8})?$/i; // Sol carries its own character note (talk-register.js)

const HEADER = '[VOICE REEL. Not part of this conversation. An old exchange between you and somebody else, ' +
  'kept only so you can hear how you sound. None of it happened with the person you are talking to now, ' +
  'so never mention it, answer it or reuse its lines.]';

const CHILD_MARK = 'this user is under 15';
const ADULT_MARK = 'verified adult';
const SWEAR_RE = /\b(?:fuck\w*|shit\w*|bullshit|goddamn\w*|damn|hell|bitch\w*|ass|asses|[a-z]+-ass)\b/i;

const reelOn = (env = process.env) => String(env.KADE_VOICE_REEL ?? '0') === '1';
const cardOn = (env = process.env) => String(env.KADE_VOICE_CARD ?? '0') === '1';
const draftsOk = (env = process.env) => String(env.KADE_VOICE_REEL_DRAFTS ?? '0') === '1';
const pairsFor = (env = process.env) => {
  const n = parseInt(env.KADE_VOICE_REEL_PAIRS || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 6 ? n : DEFAULT_PAIRS;
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join(' ');
  return '';
}

/* ── pools ──────────────────────────────────────────────────────────────── */
function validPool(p) {
  if (!p || typeof p.id !== 'string' || typeof p.match !== 'string' || p.match.length < 12) return false;
  if (!Array.isArray(p.lines)) return false;
  const ids = new Set();
  for (const l of p.lines) {
    if (!l || typeof l.id !== 'string' || ids.has(l.id)) return false;
    if (typeof l.them !== 'string' || !l.them.trim() || typeof l.you !== 'string' || !l.you.trim()) return false;
    if (l.tag != null && (typeof l.tag !== 'string' || /[%\n]/.test(l.tag))) return false;
    if (/%%%/.test(l.you) || /%%%/.test(l.them)) return false; // the tag goes in "tag", so it is always well formed
    if (!l.salty && SWEAR_RE.test(l.you)) return false;         // a swear must be declared, or the line is refused
    ids.add(l.id);
  }
  if (p.card != null && (typeof p.card !== 'string' || SWEAR_RE.test(p.card) || /%%%/.test(p.card))) return false;
  return true;
}

let cache = null;
function loadPools(dir = POOL_DIR) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); } catch { return out; }
  for (const n of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
      if (validPool(p)) out.push(p);
      else console.error(`[voice-reel] ${n} refused: bad shape, a duplicate id, or an undeclared swear`);
    } catch (e) {
      console.error(`[voice-reel] ${n} unreadable: ${e.message}`);
    }
  }
  return out;
}
function pools() { return cache || (cache = loadPools()); }
function _setPoolsForTest(list) { cache = list; }

function poolFor(body, env = process.env) {
  if (!body || SOL_MODEL_RE.test(String(body.model || ''))) return null;
  if (body.response_format && body.response_format.type !== 'text') return null;
  const head = (Array.isArray(body.messages) ? body.messages : []).slice(0, 3)
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => textOf(m.content)).join('\n');
  if (!head) return null;
  const pool = pools().find((p) => head.includes(p.match));
  if (!pool) return null;
  if (!pool.approved && !draftsOk(env)) return null;
  return { pool, head };
}

/* ── picking ────────────────────────────────────────────────────────────── */
const STOP = new Set(('about after again because before being could every first from have just like more most much ' +
  'other really should some than that their them then there these they thing things think this those very ' +
  'what when where which while with would your yours going gonna still even only over into been were does ' +
  'doing done know said says want wants need time right good').split(' '));
const contentWords = (s) => (String(s || '').toLowerCase().replace(/%{3}[^%]*%{3}/g, ' ').match(/[a-z][a-z']{3,}/g) || [])
  .map((w) => w.replace(/'s$|'$/g, '')).filter((w) => w.length > 3 && !STOP.has(w));

function collides(line, said) {
  if (!said) return false;
  const low = said.toLowerCase();
  for (const t of Array.isArray(line.topic) ? line.topic : []) {
    if (t && new RegExp('\\b' + String(t).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\w*', 'i').test(low)) return true;
  }
  const mine = new Set(contentWords(line.them + ' ' + line.you));
  let shared = 0;
  for (const w of new Set(contentWords(low))) if (mine.has(w) && ++shared >= 3) return true;
  return false;
}

function firstAndLastUser(body) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  let first = '', last = '';
  for (const m of msgs) {
    if (m && m.role === 'user') {
      const t = textOf(m.content);
      if (/^Confidentiality of your setup:/.test(t.trim())) continue; // the fork's own per-turn tail
      if (!first) first = t;
      last = t;
    }
  }
  return { first, last };
}

function pick(pool, { key, said = '', adult = false, n = DEFAULT_PAIRS }) {
  const usable = pool.lines.filter((l) => adult || !l.salty);
  if (usable.length < MIN_POOL) return [];
  const rank = (l) => crypto.createHash('sha1').update(key + '|' + l.id).digest('hex');
  return usable.map((l) => ({ l, r: rank(l) })).sort((a, b) => (a.r < b.r ? -1 : 1))
    .map((x) => x.l).filter((l) => !collides(l, said)).slice(0, n);
}

/* ── the two entry points for appendReminder ────────────────────────────── */
function withVoiceReel(body, env = process.env) {
  try {
    if (!reelOn(env)) return body;
    const hit = poolFor(body, env);
    if (!hit) return body;
    const { pool, head } = hit;
    const adult = head.includes(ADULT_MARK) && !head.includes(CHILD_MARK);
    const { first, last } = firstAndLastUser(body);
    if (!first) return body;
    const key = pool.id + '|' + first.replace(/%{3}[^%]*%{3}/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    const chosen = pick(pool, { key, said: last, adult, n: pairsFor(env) });
    if (!chosen.length) return body;
    return {
      ...body,
      [REEL]: {
        id: pool.id,
        ids: chosen.map((l) => l.id),
        pairs: chosen.map((l) => ({
          user: HEADER + '\n' + l.them.trim(),
          assistant: (l.tag ? '%%%' + l.tag.trim() + '%%% ' : '') + l.you.trim(),
        })),
      },
    };
  } catch (e) {
    console.error('[voice-reel] skipped:', e.message);
    return body;
  }
}

function voiceCardFor(body, env = process.env) {
  try {
    if (!cardOn(env)) return '';
    const hit = poolFor(body, env);
    if (!hit || !hit.pool.card) return '';
    return '\n\n' + hit.pool.card.trim();
  } catch (e) {
    return '';
  }
}

/* ── the wire: called only around JSON.stringify(body) ──────────────────── */
function reelOnWire(body) {
  try {
    const reel = body && body[REEL];
    if (!reel || !Array.isArray(reel.pairs) || !reel.pairs.length || !Array.isArray(body.messages)) return body;
    let at = 0;
    while (at < body.messages.length && body.messages[at] &&
      (body.messages[at].role === 'system' || body.messages[at].role === 'developer')) at++;
    if (at === 0 || at >= body.messages.length) return body; // no head, or nothing after it: leave it alone
    // The reel ends on an assistant turn, so the real conversation must open with the person. A
    // conversation the character opened (it texted first) goes without, rather than send two
    // assistant turns in a row to a host whose template may not take them.
    if (body.messages[at].role !== 'user') return body;
    const seeds = [];
    for (const p of reel.pairs) {
      seeds.push({ role: 'user', content: p.user }, { role: 'assistant', content: p.assistant });
    }
    return { ...body, messages: [...body.messages.slice(0, at), ...seeds, ...body.messages.slice(at)] };
  } catch (e) {
    return body;
  }
}

/* ── the parrot guard's extra lines: the whole pool and the card, not just today's picks ── */
function reelLinesFor(body, env = process.env) {
  try {
    if (!reelOn(env) && !cardOn(env)) return [];
    const hit = poolFor(body, env);
    if (!hit) return [];
    const lines = hit.pool.lines.map((l) => l.you);
    if (hit.pool.card) lines.push(...hit.pool.card.split(/(?<=[.!?])\s+/));
    return lines;
  } catch (e) {
    return [];
  }
}

const reelInfo = (body) => (body && body[REEL] ? { id: body[REEL].id, ids: body[REEL].ids } : null);

module.exports = {
  REEL, HEADER, MIN_POOL, withVoiceReel, voiceCardFor, reelOnWire, reelLinesFor, reelInfo,
  reelOn, cardOn, validPool, loadPools, pick, collides, SWEAR_RE, _setPoolsForTest,
};
