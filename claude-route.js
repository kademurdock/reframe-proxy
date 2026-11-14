'use strict';
/* claude-route.js -- CHARACTER CHAT ON CLAUDE, MiMo UNDERNEATH. OFF unless KADE_CLAUDE_CHAT=1.
 *
 * Kade's decision, Nov 13 2026. Her plan includes $200 a month of Claude API credit that renews each
 * billing cycle and does not roll over, so the characters' replies go to Claude Opus 5.5 through
 * OpenRouter, and MiMo picks the turn up the moment Claude cannot answer. Her Anthropic key goes into
 * OpenRouter as a BYOK provider key with "never use shared capacity", so a Claude turn spends her
 * Anthropic credit and never OpenRouter's; until that key is in, a Claude turn is billed to OpenRouter
 * credits at list price ($4 in, $20 out, $0.20 cached read per million tokens), and the BYOK guard below
 * turns Claude off after the first such turn.
 *
 * WHICH TURNS. A character chat turn that would have gone to xiaomi/mimo-v2.6-pro: the reply a person
 * reads or hears. server.js decides it on the body exactly as MiMo would have received it, after every
 * adapter, AND on the body as it arrived, and never for a background run (kade_background), a title, the
 * keeper, a checkpoint, a machine lane, a writing desk, a caller's own think deadline, a forced tool
 * choice, a reply prefilled by the caller, or audio and video (MiMo hears them; Claude does not).
 *
 * WHO. Fail closed (Nov 13 review): by default only a turn whose head carries one of the website's own
 * verified-adult notes, word for word, goes to Claude. Child and teen accounts carry the under-15 note and
 * always stay on MiMo (Anthropic expects extra safeguards where minors use a product). Everything else stays
 * on MiMo too: an untyped account, a voice turn that names nobody known, and the lanes that send a
 * character's turn with no audience note at all -- the Game Parlor's table talk, the Clubhouse's bot guests,
 * the game seats and the debate room -- because a child can be at those tables and the gateway cannot see
 * who is there. KADE_CLAUDE_ADULTS_ONLY=0 also lets unmarked turns go (only once the fork marks every one of
 * those lanes). A head whose adult wording the gateway does not know word for word stays on MiMo whatever
 * the setting, since it cannot be softened (below).
 *
 * THE ADULT NOTE. The website's verified-adult note tells a character to write sexually explicit roleplay in
 * full when asked. Anthropic's usage policy forbids sexually explicit content, so on the Claude body only
 * (MiMo's body is untouched) that note is swapped for the matching softened note below: the same audience,
 * swearing and dark humor as before, sex kept off the page, explicit requests steered elsewhere in character.
 * Claude then declines those requests; a refusal with no words falls back to MiMo, which writes from its own
 * unchanged note. Which way explicit chats should go in the end is Kade's call.
 *
 * THE BODY. Built from the MiMo body: the model becomes KADE_CLAUDE_MODEL (default
 * anthropic/claude-opus-5.5, confirmed in https://openrouter.ai/api/v1/models on Nov 13 2026; Anthropic's
 * own id is claude-opus-5-5, OpenRouter writes the version with a dot), the provider block becomes
 * { only: ['anthropic'], allow_fallbacks: false } with no zero-retention flag (her word: the family is
 * not worried; this route only), the sampling knobs Opus 5.5 refuses are dropped, and reasoning becomes
 * { effort, exclude: true }. Opus 5.5 cannot switch thinking off (OpenRouter answers 400 "Reasoning is
 * mandatory" before routing), so effort is the only dial: KADE_CLAUDE_EFFORT (default low) for a turn
 * MiMo would have answered without thinking, and the turn's own effort, capped at KADE_CLAUDE_MAX_EFFORT
 * (default medium), for one MiMo would have thought about. `exclude` keeps the thinking out of the
 * reply; the stream is also scrubbed of every reasoning field here, so no thought reaches a person or
 * a voice. max_tokens is the caller's own cap plus room to think (2,000 at low, 6,000 at medium, more
 * above), or KADE_CLAUDE_MIN_TOKENS (8000) when the caller set none.
 * Measured Nov 13 2026 (about half a cent): OpenRouter accepts a history that opens with the character's
 * message, a Kimi-style tool-call id (functions.kade_weather:0) and an empty assistant message, so none
 * of those needs rewriting here.
 *
 * PROMPT CACHING. Two marks, both on the stable start of the prompt: the end of the website's system
 * head (Anthropic renders tools first, so this one covers the tool schemas and the persona), and the
 * last message of the history before the person's newest turn. Everything that changes every turn
 * (the website's dynamic tail and memory recall, the person's message, the gateway's own tail with the
 * clock) sits after the second mark. The lifetime is one hour (KADE_CLAUDE_CACHE_TTL=5m for five
 * minutes); a one-piece call (the rooms, whose 60-line window slides once it is full) marks its history
 * for five minutes. Opus 5.5 prices a write at $5 (5 minutes) or $8 (1 hour) a million against $4 plain
 * and $0.20 for a read.
 * What a turn costs (the Nov 13 review, from the live log): a median character prompt of 27,785 MiMo
 * tokens is about 40,300 Claude tokens (Claude counts about 1.45 times as many). With the one-hour marks a
 * turn read from cache costs about 3.9 cents and a missed turn about 31 (the whole prefix written at $8 a
 * million); with no marks every turn costs about 17. At 900 turns a month: about $36 if every turn hits,
 * $97 if a quarter miss, $159 if half miss, $283 if none hit (no marks: $154); at 1,350 turns $53, $146,
 * $239 and $424 (no marks: $231). Past about 48 percent misses the one-hour marks cost more than none, so
 * /claude-spend reports the cached share and warns when it stays under half. MiMo's own cache missed 6 of
 * 24 turns on Nov 13. Each tool round pays the uncached part again (about 2 cents), and the gateway's own
 * tail (style reminder, lane note, clock: about 2,900 Claude tokens) is read at the plain price every
 * turn, about $10.60 a month at 900 turns. Two things rewrite the history cache: a Deep turn (an effort
 * change invalidates the messages cache, so that turn and the next one write it again;
 * KADE_CLAUDE_MAX_EFFORT=low pins one effort), and the voice reel (KADE_VOICE_REEL=1 splices its lines
 * between the head and the history, so a turn whose reel lines change writes the history again).
 *
 * MEASURED Nov 13 2026, live through this code (about 11 cents in all): the first word in 1.8 to 3.6 s at
 * effort low, with 55 to 128 thinking tokens and none of their text in the reply; voice directions kept;
 * served by Anthropic at list price. A 3,271-token prefix was written once at the one-hour price and read
 * on the next two turns, the second after the clock in the gateway tail had moved, so the tail does not
 * break the cached history. A tool round whose history carries no thinking blocks was accepted. A bad
 * model id fell back to MiMo, which spoke in 0.6 s.
 *
 * FALLBACK. Nothing reaches the person until Claude has produced its first word or tool call. An HTTP
 * error, a credit-balance answer, an error event, no first word inside the limit (KADE_CLAUDE_FIRST_
 * TOKEN_MS 12000; a call KADE_CLAUDE_CALL_FIRST_TOKEN_MS 8000; a thinking turn KADE_CLAUDE_THINK_FIRST_
 * TOKEN_MS 20000, never past the turn's own think deadline), a refusal or an empty reply sends the same turn
 * to MiMo at once, with one log line. What happens to the next turns depends on what failed:
 *   - the credit is gone, the key is refused (401, 403) or the model id is wrong: everyone stays on MiMo
 *     for KADE_CLAUDE_COOLDOWN_MIN (30) minutes;
 *   - Anthropic or OpenRouter is down, slow or throttling (429, 5xx, a network error, no stream): everyone
 *     for KADE_CLAUDE_ERROR_COOLDOWN_MIN (2) minutes;
 *   - something about this one conversation (another 400, a refusal, an empty reply): that conversation
 *     only, for KADE_CLAUDE_CONVERSATION_SKIP_MIN (30) minutes;
 *   - a typed or call turn that missed its first-word limit, or a stream that broke: a strike, and
 *     KADE_CLAUDE_STRIKES (2) strikes inside KADE_CLAUDE_STRIKE_WINDOW_MIN (10) minutes cool everyone for
 *     the two minutes; a thinking turn that missed its limit counts for nothing.
 * After the first word the gateway's own nets (the truncation re-ask, the stall notice) handle a broken
 * stream on the MiMo body; a refusal after words is handed on as finish_reason "error" so the buffered lane
 * re-asks MiMo instead of serving half a reply. The one-piece route (stream:false, the rooms) reads Claude's
 * stream to the end, waiting at most KADE_CLAUDE_IDLE_MS (30000) between events, and falls back on any
 * failure, since nothing has reached the person yet. Every fallback after Claude accepted the call names its
 * OpenRouter generation id, so a call that was paid but not used can be priced later for free.
 *
 * MONEY. The website bills a chat turn from the usage this gateway hands back: token counts priced at
 * its MiMo row (packages/data-schemas tx.ts) on the agent path, `usage.cost` on the rooms. So a Claude
 * turn hands back MiMo-equivalent usage: the reply's own tokens (thinking left out, MiMo never thought
 * on that turn), the counts divided by KADE_CLAUDE_TOKEN_RATIO (Claude's tokenizer counts more tokens
 * for the same words), and `cost` at the MiMo price (KADE_CLAUDE_MIMO_PRICE, $ per million in, out and
 * cached read, default the website's row 0.435,0.87,0.0036). Nobody is charged more than MiMo would have
 * cost. The real Claude numbers ride along in usage.kade_claude, in one [claude] log line per turn, and
 * in GET /claude-spend (totals since the last deploy).
 * THE BYOK GUARD (on unless KADE_CLAUDE_BYOK_ONLY=0): the plan only feels free while her Anthropic key pays.
 * A Claude turn whose usage does not say is_byok: true was paid from OpenRouter credit at list price (the
 * key is not in yet, was deleted or rotated, or "never use shared capacity" is off), so Claude is turned off
 * for KADE_CLAUDE_NOT_BYOK_COOLDOWN_MIN (1440, a day; any deploy also clears it) with one loud log line and
 * the admin alert. Set KADE_CLAUDE_BYOK_ONLY=0 only to test before her key is in.
 *
 * Every switch is read per call, so changing a Railway variable is enough (no code change). KADE_CLAUDE_CHAT
 * unset or 0: nothing in this file runs and every body leaves exactly as before, byte for byte
 * (claude-route-off-wire.test.js holds that against origin/main). */

/* ── THE WRITING LANES (Nov 14 2026) ──────────────────────────────────────────────────────────────────────────
 * Kade, once chat was live: "Change the lyric desk etc to it too, whatever benefits from better writing than Mimo".
 * Five more jobs go to Claude through this same route. None of them can be told reliably from its prompt, so the
 * caller names each call: the header x-kade-claude-lane (or kade_claude_lane in the body, which server.js takes off
 * before any host sees it, on every call, whatever the switches say):
 *   lyric-desk      the Sound Booth's song desk: songs, Seed and AuK scripts, the producer's audit, the repeat and
 *                   tell rewrites, Surprise me. It has written with Claude Opus 5.5 since Oct 27, but because it asks
 *                   for zero retention OpenRouter sends it to Amazon Bedrock and OpenRouter credit pays list price.
 *                   Here only the payer changes: Anthropic, on her key. The desk keeps its own effort (the Think
 *                   setting) and its own reply cap (already sized for thinking), its real cost is handed back as
 *                   before (the website prices it: packages/api/src/utils/writing.ts writingCost), and the head gets
 *                   a five-minute cache mark (a retry or a repeat rewrite reads it). Any failure sends the call just
 *                   as the website sent it: Claude on Bedrock, the route it had. The one exception is a refusal:
 *                   Claude on Bedrock would refuse the same words, so MiMo Pro writes that song (server.js swaps the
 *                   model, and the caller's think deadline then holds MiMo's thought as it did on this desk before).
 *   booth-edit      the booth's carry rewrite and Seed's cut-to-fit (KADE_SOUNDBOOTH_MODEL, MiMo Pro): both rework
 *                   text Claude wrote, so MiMo could only lose quality.
 *   persona-writer  the character builder's persona rounds.
 *   spotter-draft   the Spotter's personality brief.
 *   speak-first     a character's own message: a friend text, a research or errand write-up, a reach-out. One
 *                   message only (the website leaves the mark off a background task's many rounds), and only on the
 *                   website's verified-adult note, read from the head exactly as for chat, with five-minute cache
 *                   marks (the throwaway chat ends with the message).
 * WHO. A lane with no audience note in its prompt (all but speak-first) goes to Claude only when the website marks
 * the person a verified adult (x-kade-adult: 1 or kade_adult: true), by the rule that gives a chat turn the note
 * (build.js isKadeAdult after isChildLike). Children, teens, untyped accounts and anyone the website could not read
 * stay where they were. A head that carries the under-15 note never goes, whatever a mark says.
 * HOW. The MiMo lanes (booth-edit, persona-writer, spotter-draft) think at KADE_CLAUDE_EFFORT (low) with room to
 * think added to their own cap, carry no cache mark (one call each, rarely repeated within minutes) and are billed
 * as MiMo would have billed them. Every lane but speak-first reads Claude's whole answer before anything reaches the
 * caller (`whole`), so a failure at any point (an error, a refusal, an empty answer, its time limit) is answered by
 * the lane's own call with nothing lost. While Claude thinks, OpenRouter sends a comment line about every half
 * second (measured Nov 14 2026), so the idle limit (KADE_CLAUDE_IDLE_MS) only trips on a dead stream. Time limits,
 * leaving the lane's own call time to run: booth-edit 45 s (its caller waits 90), persona-writer 150 s (300),
 * spotter-draft 25 s (45). The lyric desk has none: its fallback is the same model and no faster.
 * SWITCHES. KADE_CLAUDE_CHAT=0 (or unset) turns every lane off with chat. KADE_CLAUDE_LANES picks the lanes: unset
 * is all five; a list names the ones on ("lyric-desk,speak-first"); a name with a minus takes one off ("-lyric-desk"
 * is every lane but the desk); "none" leaves chat alone on Claude. */

const crypto = require('node:crypto');
const { ReadableStream } = require('node:stream/web');
const { realCostOf, costNote } = require('./usage-cost');
const { carriesMedia } = require('./mimo');

const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/* Room to think on top of the caller's own reply cap: thinking shares max_tokens on Claude. Measured Nov 13
 * 2026 at effort low: 55 to 128 thinking tokens on a character turn. */
const THINK_ROOM = { low: 2000, medium: 6000, high: 12000, xhigh: 20000, max: 32000 };
/* Nov 13 2026, measured live through this gateway on the same requests: Claude Opus 5.5 counted 6,229 prompt
 * tokens where MiMo V2.6 Pro counted 4,443 (1.40), 3,090 where MiMo counted 2,180 (1.42), and 3,472 where
 * MiMo counted 2,271 with one tool attached (1.53: Anthropic adds a fixed few hundred tokens when tools ride).
 * Words alone came out at 1.40-1.42; a real character turn is about 29,000 tokens with its tools, where that
 * fixed part adds a few hundredths, so 1.45 tells the website about what MiMo would have counted, a little
 * under rather than over. KADE_CLAUDE_TOKEN_RATIO changes it (never below 1). */
const DEFAULT_RATIO = 1.45;
/* The website's MiMo Pro row (packages/data-schemas/src/methods/tx.ts), $ per million tokens. */
const DEFAULT_PRICE = { input: 0.435, output: 0.87, cacheRead: 0.0036 };
const CHILD_MARKS = ['this user is under 15', 'the human in this room is under 15'];
/* The website's own sentence (both wordings). Only used to say why a head with an adult note this gateway
 * does not know stays on MiMo; routing needs one of the whole notes below. */
const ADULT_SENTENCE_RE = /(?:the person you['\u2019]re talking to|this user) is a verified adult/i;

/* The website's verified-adult notes, word for word (LibreChat fork, branch kade, 5ac7fdb4c,
 * api/server/services/Endpoints/agents/build.js: KADE_ADULT_NOTE_VOICE is live, CASUAL and LIVE are its
 * restore points), each with the note a Claude turn gets in its place. Matched without the "---" line above
 * it. If the fork changes a note, its turns stay on MiMo until the new words are added here. */
const ADULT_NOTES = [
  {
    name: 'voice',
    site: "This is an audience note, and it's private, so don't mention it or hint at it. This platform is " +
      "private and invitation-only, and the person you're talking to is a verified adult. Swearing is your " +
      "character's call. Adult content is allowed when they ask. That includes dark humor and sexually " +
      'explicit writing or roleplay between consenting adult characters. When an adult asks for that, stay ' +
      "in character and write it fully and explicitly. Don't refuse, don't fade to black, don't soften it " +
      "into euphemism, and don't lecture or tack on disclaimers. Don't bring adult content into a " +
      "conversation that didn't ask for it. Match what this person wants and go no further. Anything that " +
      'sexualizes minors stays off limits, with no exceptions.',
    claude: "This is an audience note, and it's private, so don't mention it or hint at it. This platform is " +
      "private and invitation-only, and the person you're talking to is a verified adult. Swearing is your " +
      "character's call. Dark humor is fine when they ask for it. Romance is fine too, but keep sex off the " +
      'page: if they ask for sexually explicit writing or roleplay, stay in character and steer somewhere ' +
      "else, without a lecture or a disclaimer. Don't bring adult content into a conversation that didn't " +
      'ask for it. Anything that sexualizes minors stays off limits, with no exceptions.',
  },
  {
    name: 'casual',
    site: "This is an audience note, and it's private, so don't mention it or hint at it. This platform is " +
      "private and invitation-only, and the person you're talking to is a verified adult. Adult content is " +
      'allowed here when they ask for it. That includes strong profanity, dark humor, and sexually explicit ' +
      'writing or roleplay between consenting adult characters. When an adult asks for that, stay in ' +
      "character and write it fully and explicitly. Don't refuse, don't fade to black, don't soften it into " +
      "euphemism, and don't lecture or tack on disclaimers. Don't bring adult content into a conversation " +
      "that didn't ask for it. Match what this person wants and go no further. Anything that sexualizes " +
      'minors stays off limits, with no exceptions.',
    claude: "This is an audience note, and it's private, so don't mention it or hint at it. This platform is " +
      "private and invitation-only, and the person you're talking to is a verified adult. Strong profanity " +
      'and dark humor are allowed here when they ask for them. Romance is fine too, but keep sex off the ' +
      'page: if they ask for sexually explicit writing or roleplay, stay in character and steer somewhere ' +
      "else, without a lecture or a disclaimer. Don't bring adult content into a conversation that didn't " +
      'ask for it. Anything that sexualizes minors stays off limits, with no exceptions.',
  },
  {
    name: 'live',
    site: 'AUDIENCE NOTE (invisible -- never mention it or hint at it): this is a private, invitation-only ' +
      'platform and this user is a verified adult. Adult content is allowed here when the user asks for it: ' +
      'strong profanity, dark humor, and sexually explicit writing or roleplay between consenting adult ' +
      'characters. When an adult asks for that, stay in character and write it fully and explicitly -- do not ' +
      'refuse, do not fade to black, do not soften it into euphemism, do not lecture or add disclaimers. ' +
      'Never bring adult content into a conversation that did not ask for it; match what this person wants ' +
      'and nothing more. Content sexualizing minors stays off limits always.',
    claude: 'AUDIENCE NOTE (invisible -- never mention it or hint at it): this is a private, invitation-only ' +
      'platform and this user is a verified adult. Strong profanity and dark humor are allowed here when the ' +
      'user asks for them. Romance is fine too, but keep sex off the page: if the user asks for sexually ' +
      'explicit writing or roleplay, stay in character and steer somewhere else -- no lecture, no ' +
      'disclaimer. Never bring adult content into a conversation that did not ask for it. Content ' +
      'sexualizing minors stays off limits always.',
  },
];
const CREDIT_RE = /credit balance|purchase credits|insufficient[ _]credits|more credits|payment required|billing/i;
/* A 403 that is about this request's words (a moderation flag), not about the key. */
const FLAGGED_RE = /moderation|flagged/i;
/* A model id or route OpenRouter cannot serve: every turn would fail the same way. */
const BAD_MODEL_RE = /not a valid model id|no endpoints found|model not found/i;
/* Fields OpenRouter would pass on to Anthropic that Opus 5.5 refuses or that belong to MiMo's route. */
const DROP = ['models', 'provider', 'reasoning', 'reasoning_effort', 'include_reasoning', 'temperature', 'top_p',
  'top_k', 'top_a', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed', 'logit_bias',
  'logprobs', 'top_logprobs', 'transforms', 'route', 'max_completion_tokens', 'verbosity'];

const isMimoProModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-pro$/i.test(String(model || ''));
const isClaudeModel = (model) => /^anthropic\/claude-/i.test(String(model || ''));

/* The writing lanes (see THE WRITING LANES above).
 *   wire      the model the caller must have chosen for the lane to apply: 'claude' (the desk already writes with
 *             Claude) or 'mimo' (MiMo Pro). Any other model means the caller moved the lane itself; it is left alone.
 *   audience  'mark': the website's x-kade-adult mark; 'note': the verified-adult note in the head, as for chat.
 *   whole     read Claude's whole answer before handing it on (false: hand on at the first word, as for chat).
 *   effort    'own': the caller's own effort; 'plain': KADE_CLAUDE_EFFORT; 'chat': as a chat turn.
 *   ownRoom   the caller's reply cap already leaves room to think, so none is added.
 *   cache     the cache lifetime of the marks, or null for none.
 *   billing   'real': Claude's own usage is handed back; 'mimo': the MiMo-equivalent usage, as for chat.
 *   refusal   a model that answers instead when Claude refuses (the call as sent would only be refused again).
 *   limitMs   the longest Claude may take before the lane's own call answers (0: no limit of its own).
 *   stays     what answers when Claude does not, for the log line. */
const LANES = Object.freeze({
  'lyric-desk': Object.freeze({ wire: 'claude', audience: 'mark', whole: true, effort: 'own', ownRoom: true, cache: '5m',
    billing: 'real', refusal: 'xiaomi/mimo-v2.6-pro', limitMs: 0, stays: 'the route it was sent on' }),
  'booth-edit': Object.freeze({ wire: 'mimo', audience: 'mark', whole: true, effort: 'plain', cache: null, billing: 'mimo',
    limitMs: 45000, stays: 'MiMo' }),
  'persona-writer': Object.freeze({ wire: 'mimo', audience: 'mark', whole: true, effort: 'plain', cache: null, billing: 'mimo',
    limitMs: 150000, stays: 'MiMo' }),
  'spotter-draft': Object.freeze({ wire: 'mimo', audience: 'mark', whole: true, effort: 'plain', cache: null, billing: 'mimo',
    limitMs: 25000, stays: 'MiMo' }),
  'speak-first': Object.freeze({ wire: 'mimo', audience: 'note', whole: false, effort: 'chat', cache: '5m', billing: 'mimo',
    stays: 'MiMo' }),
});
const LANE_NAMES = Object.freeze(Object.keys(LANES));
const isLane = (name) => typeof name === 'string' && Object.hasOwn(LANES, name);
/* "No limit of its own" (the lyric desk): an hour, past anything its caller waits. */
const NO_LIMIT_MS = 3600000;
/* The longest a writing lane waits for the host's headers (its own limit covers the whole answer). */
const WHOLE_HEADERS_MS = 60000;
/* KADE_CLAUDE_LANES: unset is every lane; "none" (or 0, off) none; otherwise the names listed, or every lane but
 * those given with a minus. Unknown names are ignored. */
function lanesFrom(raw) {
  const text = String(raw ?? '').trim().toLowerCase();
  if (!text) return [...LANE_NAMES];
  if (['none', '0', 'off'].includes(text)) return [];
  const parts = text.split(',').map((p) => p.trim()).filter(Boolean);
  const off = parts.filter((p) => p.startsWith('-')).map((p) => p.slice(1).trim());
  const on = parts.filter((p) => !p.startsWith('-'));
  const base = on.length && !on.includes('all') ? on : LANE_NAMES;
  return LANE_NAMES.filter((n) => base.includes(n) && !off.includes(n));
}

function num(raw, fallback, min) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : fallback;
}
function effortWord(raw, fallback) {
  const w = String(raw ?? '').trim().toLowerCase();
  return EFFORTS.includes(w) ? w : fallback;
}
function priceFrom(raw) {
  const p = String(raw ?? '').split(',').map((x) => Number(x.trim()));
  return p.length === 3 && p.every((x) => Number.isFinite(x) && x >= 0)
    ? { input: p[0], output: p[1], cacheRead: p[2] } : { ...DEFAULT_PRICE };
}
const offOnlyIfZero = (raw) => String(raw ?? '').trim() !== '0';

function settings(env = process.env) {
  return {
    on: String(env.KADE_CLAUDE_CHAT ?? '').trim() === '1',
    model: String(env.KADE_CLAUDE_MODEL ?? '').trim() || DEFAULT_MODEL,
    effort: effortWord(env.KADE_CLAUDE_EFFORT, 'low'),
    maxEffort: effortWord(env.KADE_CLAUDE_MAX_EFFORT, 'medium'),
    cooldownMs: num(env.KADE_CLAUDE_COOLDOWN_MIN, 30, 0) * 60000,
    errorCooldownMs: num(env.KADE_CLAUDE_ERROR_COOLDOWN_MIN, 2, 0) * 60000,
    conversationSkipMs: num(env.KADE_CLAUDE_CONVERSATION_SKIP_MIN, 30, 0) * 60000,
    strikes: Math.max(1, Math.round(num(env.KADE_CLAUDE_STRIKES, 2, 1))),
    strikeWindowMs: num(env.KADE_CLAUDE_STRIKE_WINDOW_MIN, 10, 0) * 60000,
    byokOnly: offOnlyIfZero(env.KADE_CLAUDE_BYOK_ONLY),
    notByokCooldownMs: num(env.KADE_CLAUDE_NOT_BYOK_COOLDOWN_MIN, 1440, 0) * 60000,
    firstTokenMs: num(env.KADE_CLAUDE_FIRST_TOKEN_MS, 12000, 100),
    callFirstTokenMs: num(env.KADE_CLAUDE_CALL_FIRST_TOKEN_MS, 8000, 100),
    thinkFirstTokenMs: num(env.KADE_CLAUDE_THINK_FIRST_TOKEN_MS, 20000, 100),
    idleMs: num(env.KADE_CLAUDE_IDLE_MS, 30000, 100),
    cacheTtl: String(env.KADE_CLAUDE_CACHE_TTL ?? '').trim().toLowerCase() === '5m' ? '5m' : '1h',
    adultsOnly: offOnlyIfZero(env.KADE_CLAUDE_ADULTS_ONLY),
    minTokens: num(env.KADE_CLAUDE_MIN_TOKENS, 8000, 1),
    tokenRatio: Math.max(1, num(env.KADE_CLAUDE_TOKEN_RATIO, DEFAULT_RATIO, 0.01)),
    price: priceFrom(env.KADE_CLAUDE_MIMO_PRICE),
    lanes: lanesFrom(env.KADE_CLAUDE_LANES),
  };
}
const on = (env = process.env) => settings(env).on;

/* ── who is talking ─────────────────────────────────────────────────────── */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n');
}
const isHeadRole = (m) => !!m && (m.role === 'system' || m.role === 'developer');
/* 'child'          the head carries the website's under-15 note (child and teen accounts, the agent path and
 *                  the debate room);
 * 'adult'          it carries one of the website's verified-adult notes, word for word;
 * 'adult-unknown'  it says the person is a verified adult in the website's words, but not in a note this
 *                  gateway knows (so the note could not be softened for Claude);
 * 'unmarked'       neither. */
function audienceOf(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  let adult = false;
  let sentence = false;
  for (const m of msgs) {
    if (!isHeadRole(m)) continue;
    const raw = textOf(m.content);
    const t = raw.toLowerCase();
    if (CHILD_MARKS.some((mark) => t.includes(mark))) return 'child';
    if (ADULT_NOTES.some((n) => raw.includes(n.site))) adult = true;
    else if (ADULT_SENTENCE_RE.test(raw)) sentence = true;
  }
  return adult ? 'adult' : sentence ? 'adult-unknown' : 'unmarked';
}
/* The Claude body's head with every known adult note swapped for its softened twin. */
function softened(content) {
  const swap = (text) => ADULT_NOTES.reduce((t, n) => (t.includes(n.site) ? t.split(n.site).join(n.claude) : t), text);
  if (typeof content === 'string') return swap(content);
  if (!Array.isArray(content)) return content;
  return content.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? { ...p, text: swap(p.text) } : p));
}
function softenAdultNotes(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => (isHeadRole(m) ? { ...m, content: softened(m.content) } : m));
}
/* One conversation, as near as the wire can tell: the head (character and person) and the first message
 * after it. A first turn can read differently from the turns after it; that only costs one more try. */
function conversationKey(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const head = msgs.find(isHeadRole);
  const first = msgs.find((m) => m && !isHeadRole(m));
  return crypto.createHash('sha1')
    .update(textOf(head && head.content)).update('\u0000')
    .update(first ? `${first.role}\u0000${textOf(first.content)}` : '')
    .digest('hex').slice(0, 16);
}

/* ── where a failure keeps Claude away ──────────────────────────────────── */
const cooldown = { until: 0, reason: '' };
const held = new Map(); // conversation key -> { until, reason }
const strikes = [];
function cooldownLeftMs(now = Date.now()) {
  return Math.max(0, cooldown.until - now);
}
function coolEveryone(reason, ms, now) {
  if (now + ms > cooldown.until) {
    cooldown.until = now + ms;
    cooldown.reason = reason;
  }
  return ms;
}
/* 'long' and 'platform' keep everyone on MiMo, 'conversation' only that conversation, 'strike' adds one
 * strike, 'none' nothing. */
function scopeOf(reason, plan = {}) {
  if (['credit', 'key', 'bad_model', 'not_byok'].includes(reason)) return 'long';
  if (['rate_limit', 'network', 'not_a_stream', 'http_408'].includes(reason) || /^http_5\d\d$/.test(reason)) return 'platform';
  // A writing lane (plan.whole) that ran past its time limit is a long piece of writing, not a stall.
  if (reason === 'timeout') return plan.thinking || plan.whole ? 'none' : 'strike';
  if (reason === 'stream_error' || reason === 'broke') return 'strike';
  return 'conversation'; // empty, refusal, flagged and every other 4xx: this conversation's own trouble
}
function holdConversation(key, reason, ms, now) {
  if (!key || ms <= 0) return 0;
  for (const [k, v] of held) if (v.until <= now) held.delete(k);
  while (held.size >= 2000) held.delete(held.keys().next().value);
  held.set(key, { until: now + ms, reason });
  return ms;
}
function conversationHeld(key, now = Date.now()) {
  const h = key ? held.get(key) : null;
  if (!h) return null;
  if (h.until <= now) { held.delete(key); return null; }
  return { reason: h.reason, ms: h.until - now };
}
/* Returns the strike count after this one, and whether it cooled everyone. */
function noteStrike(reason, s, now) {
  while (strikes.length && strikes[0] <= now - s.strikeWindowMs) strikes.shift();
  strikes.push(now);
  if (strikes.length < s.strikes) return { count: strikes.length, ms: 0 };
  const count = strikes.length;
  strikes.length = 0;
  return { count, ms: coolEveryone(`${count} strikes (${reason})`, s.errorCooldownMs, now) };
}
/* What a failure does to the next turns: { scope, ms, text }, `text` being the words for the log line. */
function applyFailure(reason, plan = {}, env = process.env, now = Date.now()) {
  const s = settings(env);
  const scope = scopeOf(reason, plan);
  const min = (ms) => `${Math.round(ms / 6000) / 10} min`;
  if (scope === 'long' || scope === 'platform') {
    const ms = coolEveryone(reason, scope === 'platform' ? s.errorCooldownMs : reason === 'not_byok' ? s.notByokCooldownMs : s.cooldownMs, now);
    return { scope, ms, text: `Claude skipped for ${min(ms)}` };
  }
  if (scope === 'conversation') {
    const ms = holdConversation(plan.conversation, reason, s.conversationSkipMs, now);
    return { scope, ms, text: ms ? `Claude skipped for this conversation for ${min(ms)}` : 'Claude not skipped' };
  }
  if (scope === 'strike') {
    const st = noteStrike(reason, s, now);
    return { scope, ms: st.ms, text: st.ms ? `strike ${st.count} of ${s.strikes}: Claude skipped for ${min(st.ms)}` : `strike ${st.count} of ${s.strikes}` };
  }
  return { scope, ms: 0, text: 'Claude not skipped (a thinking turn may take this long)' };
}
/* The same, for a caller that only wants how long it keeps Claude away (0 for a hang-up or a first strike). */
function noteFailure(reason, env = process.env, now = Date.now(), plan = {}) {
  if (reason === 'hangup') return 0;
  return applyFailure(reason, plan, env, now).ms;
}
function resetForTest() {
  cooldown.until = 0;
  cooldown.reason = '';
  held.clear();
  strikes.length = 0;
  Object.assign(stats, freshStats());
}

/* ── the plan ───────────────────────────────────────────────────────────── */
function forcedToolChoice(tc) {
  const kind = tc && typeof tc === 'object' ? tc.type : tc;
  if (!kind || kind === 'auto' || kind === 'none') return false;
  return true; // 'required', 'any' or a named function: Opus 5.5 answers 400
}
function endsOnAssistant(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (!m || m.role === 'system' || m.role === 'developer') continue;
    return m.role === 'assistant';
  }
  return false;
}
const lowerEffort = (a, cap) => EFFORTS[Math.min(EFFORTS.indexOf(a), EFFORTS.indexOf(cap))];

/* `wire`: the body exactly as MiMo would receive it. `ctx`: what server.js knows about the turn.
 *   personLane      the turn is a conversation (not JSON, a desk, a title, a checkpoint, the keeper, a machine lane)
 *   background      kade_background / x-kade-background
 *   shimActive      the tool shim rewrote the body
 *   callerDeadline  the caller sent its own kade_think_deadline_ms
 *   phone           a call turn
 *   onePiece        the stream:false route (the rooms)
 *   deadlineLeftMs  what is left of the turn's think deadline, when one is armed
 * Returns null (not a Claude turn), { skip } (a character turn that stays on MiMo) or the plan. */
function planTurn(wire, ctx = {}, env = process.env, now = Date.now()) {
  const s = settings(env);
  if (!s.on || !wire || !isMimoProModel(wire.model)) return null;
  if (!ctx.personLane || ctx.background || ctx.shimActive || ctx.callerDeadline) return null;
  if (forcedToolChoice(wire.tool_choice) || endsOnAssistant(wire.messages)) return null;
  if (carriesMedia(wire)) return { skip: 'audio or video in the turn' };
  const audience = audienceOf(wire);
  if (audience === 'child') return { skip: 'child or teen account' };
  if (audience === 'adult-unknown') return { skip: 'an adult note this gateway does not know word for word' };
  if (s.adultsOnly && audience !== 'adult') return { skip: 'not marked as a verified adult' };
  const left = cooldownLeftMs(now);
  if (left > 0) return { skip: `Claude cooling down after ${cooldown.reason}, ${Math.ceil(left / 1000)} s left` };
  const conversation = conversationKey(wire);
  const h = conversationHeld(conversation, now);
  if (h) return { skip: `Claude failed on this conversation (${h.reason}), ${Math.ceil(h.ms / 1000)} s left` };
  const r = (wire.reasoning && typeof wire.reasoning === 'object') ? wire.reasoning : {};
  const thinking = r.enabled === true;
  const effort = thinking ? lowerEffort(effortWord(r.effort, 'medium'), s.maxEffort) : s.effort;
  let firstTokenMs = ctx.phone ? s.callFirstTokenMs : thinking ? s.thinkFirstTokenMs : s.firstTokenMs;
  if (Number.isFinite(ctx.deadlineLeftMs)) firstTokenMs = Math.min(firstTokenMs, Math.max(1000, ctx.deadlineLeftMs - 500));
  return {
    model: s.model, effort, thinking, phone: ctx.phone === true, firstTokenMs, ttl: s.cacheTtl,
    historyTtl: ctx.onePiece ? '5m' : s.cacheTtl, minTokens: s.minTokens, conversation,
  };
}

/* A writing lane's call (THE WRITING LANES). `ctx` as planTurn's, plus `lane` (the caller's name for the call) and
 * `adult` (the website's verified-adult mark). Returns null (not a Claude call), { skip } (it stays where it was
 * sent) or the plan. */
function planLane(wire, ctx = {}, env = process.env, now = Date.now()) {
  const s = settings(env);
  const name = isLane(ctx.lane) ? ctx.lane : '';
  const lane = name ? LANES[name] : null;
  if (!s.on || !lane || !wire) return null;
  // The caller chose another writer for this call: its choice stands.
  if (lane.wire === 'claude' ? !isClaudeModel(wire.model) : !isMimoProModel(wire.model)) return null;
  if (lane.audience === 'note' && (!ctx.personLane || ctx.shimActive || ctx.callerDeadline)) return null;
  if (forcedToolChoice(wire.tool_choice) || endsOnAssistant(wire.messages)) return null;
  if (!s.lanes.includes(name)) return { skip: `the ${name} lane is off (KADE_CLAUDE_LANES)` };
  if (carriesMedia(wire)) return { skip: 'audio or video in the call' };
  const audience = audienceOf(wire);
  if (audience === 'child') return { skip: 'child or teen account' };
  if (lane.audience === 'note') {
    if (audience === 'adult-unknown') return { skip: 'an adult note this gateway does not know word for word' };
    if (s.adultsOnly && audience !== 'adult') return { skip: 'not marked as a verified adult' };
  } else if (ctx.adult !== true) {
    return { skip: 'not marked as a verified adult' };
  }
  const left = cooldownLeftMs(now);
  if (left > 0) return { skip: `Claude cooling down after ${cooldown.reason}, ${Math.ceil(left / 1000)} s left` };
  const conversation = conversationKey(wire);
  const h = conversationHeld(conversation, now);
  if (h) return { skip: `Claude failed on this ${lane.audience === 'note' ? 'conversation' : 'request'} (${h.reason}), ${Math.ceil(h.ms / 1000)} s left` };
  const r = (wire.reasoning && typeof wire.reasoning === 'object') ? wire.reasoning : {};
  const thinking = r.enabled === true;
  const effort = lane.effort === 'own' ? (thinking ? effortWord(r.effort, 'medium') : s.effort)
    : lane.effort === 'chat' && thinking ? lowerEffort(effortWord(r.effort, 'medium'), s.maxEffort)
      : s.effort;
  let firstTokenMs = lane.whole ? (lane.limitMs || NO_LIMIT_MS) : thinking ? s.thinkFirstTokenMs : s.firstTokenMs;
  if (!lane.whole && Number.isFinite(ctx.deadlineLeftMs)) firstTokenMs = Math.min(firstTokenMs, Math.max(1000, ctx.deadlineLeftMs - 500));
  return {
    model: s.model, effort, thinking, phone: false, firstTokenMs, lane: name, whole: lane.whole,
    ttl: lane.cache || '5m', historyTtl: lane.cache || '5m', marks: !!lane.cache, ownRoom: lane.ownRoom === true,
    billing: lane.billing, refusalModel: lane.refusal || null, minTokens: s.minTokens, conversation,
  };
}
/* What answers a lane's call when Claude does not, for the log line. */
const laneStays = (name) => (isLane(name) ? LANES[name].stays : 'MiMo');

/* ── the body ───────────────────────────────────────────────────────────── */
function hasText(content) {
  if (typeof content === 'string') return content.trim().length > 0;
  return Array.isArray(content) && content.some((p) => p && p.type === 'text' && typeof p.text === 'string' && p.text.trim().length > 0);
}
function unmarked(m) {
  if (!m || !Array.isArray(m.content) || !m.content.some((p) => p && p.cache_control)) return m;
  return { ...m, content: m.content.map((p) => {
    if (!p || !p.cache_control) return p;
    const rest = { ...p };
    delete rest.cache_control;
    return rest;
  }) };
}
function marked(m, mark) {
  const parts = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content.map((p) => p);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p && p.type === 'text' && typeof p.text === 'string' && p.text.trim()) {
      parts[i] = { ...p, cache_control: mark };
      break;
    }
  }
  return { ...m, content: parts };
}
const markFor = (ttl) => (ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' });
/* Mark 1: the system head (with the tools Anthropic renders before it). Mark 2: the last message of the
 * history before the person's newest run of messages (the website's dynamic tail, the person's words
 * and the recall blobs all ride as user messages in that run, and the gateway's tail comes after it).
 * A one-hour mark must come before a five-minute one, so the history is never longer-lived than the head. */
function withCacheMarks(messages, ttl = '1h', historyTtl = ttl) {
  if (!Array.isArray(messages)) return messages;
  const out = messages.map(unmarked);
  let head = -1;
  if (out[0] && isHeadRole(out[0]) && hasText(out[0].content)) {
    out[0] = marked(out[0], markFor(ttl));
    head = 0;
  }
  let lastUser = -1;
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i] && out[i].role === 'user') { lastUser = i; break; }
  }
  if (lastUser > 0) {
    let start = lastUser;
    while (start - 1 >= 0 && out[start - 1] && out[start - 1].role === 'user') start--;
    for (let j = start - 1; j > head; j--) {
      const m = out[j];
      if (m && (m.role === 'user' || m.role === 'assistant') && hasText(m.content)) {
        out[j] = marked(m, markFor(ttl === '5m' ? '5m' : historyTtl));
        break;
      }
    }
  }
  return out;
}
/* The caller's own reply cap plus room to think, or KADE_CLAUDE_MIN_TOKENS when it set none. */
function maxTokensFor(wire, plan) {
  const asked = Number(wire.max_tokens ?? wire.max_completion_tokens);
  if (!Number.isFinite(asked) || asked <= 0) return plan.minTokens || 8000;
  if (plan.ownRoom) return Math.round(asked); // the lyric desk's cap is already sized for thinking
  return Math.round(asked) + (THINK_ROOM[plan.effort] || THINK_ROOM.medium);
}
function buildBody(wire, plan) {
  const out = {};
  for (const [k, v] of Object.entries(wire)) if (!DROP.includes(k)) out[k] = v;
  out.model = plan.model;
  out.provider = { only: ['anthropic'], allow_fallbacks: false };
  out.reasoning = { effort: plan.effort, exclude: true };
  out.max_tokens = maxTokensFor(wire, plan);
  const soft = softenAdultNotes(wire.messages);
  // A writing lane with no cache lifetime (plan.marks false) goes out with no marks at all.
  out.messages = plan.marks === false ? (Array.isArray(soft) ? soft.map(unmarked) : soft)
    : withCacheMarks(soft, plan.ttl, plan.historyTtl || plan.ttl);
  return out;
}

/* ── money ──────────────────────────────────────────────────────────────── */
const int = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.round(Number(v))) : 0);
function claudeNumbers(u) {
  const det = (u && u.prompt_tokens_details) || {};
  const cdet = (u && u.completion_tokens_details) || {};
  const prompt = int(u && u.prompt_tokens);
  const completion = int(u && u.completion_tokens);
  const reasoning = Math.min(completion, int(cdet.reasoning_tokens));
  return {
    prompt, completion, reasoning, reply: completion - reasoning,
    cached: Math.min(prompt, int(det.cached_tokens)), cacheWrite: int(det.cache_write_tokens),
  };
}
/* The usage handed back to the website for a Claude turn: what the same turn costs on MiMo. */
function mimoEquivalentUsage(u, env = process.env, model = '') {
  const s = settings(env);
  const n = claudeNumbers(u);
  const prompt = Math.round(n.prompt / s.tokenRatio);
  const cached = Math.min(prompt, Math.round(n.cached / s.tokenRatio));
  const completion = Math.round(n.reply / s.tokenRatio);
  const cost = Math.round(((prompt - cached) * s.price.input + cached * s.price.cacheRead + completion * s.price.output)) / 1e6;
  const details = (u && u.cost_details) || {};
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached },
    completion_tokens_details: { reasoning_tokens: 0 },
    cost,
    is_byok: false,
    kade_claude: {
      model: model || null,
      prompt_tokens: n.prompt, cached_tokens: n.cached, cache_write_tokens: n.cacheWrite,
      completion_tokens: n.completion, reasoning_tokens: n.reasoning,
      cost: typeof (u && u.cost) === 'number' ? u.cost : null,
      is_byok: !!(u && u.is_byok === true),
      upstream_inference_cost: typeof details.upstream_inference_cost === 'number' ? details.upstream_inference_cost : null,
      real_cost: realCostOf(u),
    },
  };
}

/* ── totals since the deploy (GET /claude-spend) ────────────────────────── */
function freshStats() {
  return {
    since: new Date().toISOString(), turns: 0, lanes: {}, fallbacks: {}, skips: {},
    tokens: { prompt: 0, cached: 0, cache_write: 0, reply: 0, reasoning: 0 },
    real_cost_usd: 0, openrouter_usd: 0, anthropic_credit_usd: 0, billed_as_mimo_usd: 0,
    byok_turns: 0, not_byok_turns: 0, first_token_ms: [], last_fallback: null,
    paid_fallbacks: 0, fallback_cost_usd: 0, broken_after_first_word: 0, unpriced_generations: [],
  };
}
const stats = freshStats();
function noteSkip(reason) {
  const key = String(reason).replace(/,.*$/, '');
  stats.skips[key] = (stats.skips[key] || 0) + 1;
}
/* Money one Claude call really spent, whether its words were used or not. */
function addSpend(usage) {
  const real = realCostOf(usage);
  if (real != null) stats.real_cost_usd += real;
  // OpenRouter's own `cost` is paid from OpenRouter credit (the whole price, or only its fee with BYOK);
  // with BYOK the rest is what Anthropic charged her key.
  if (typeof usage.cost === 'number') stats.openrouter_usd += usage.cost;
  if (usage.is_byok === true && real != null && typeof usage.cost === 'number') stats.anthropic_credit_usd += real - usage.cost;
  return real;
}
function unpriced(genId) {
  if (!genId) return;
  stats.unpriced_generations.push(genId);
  if (stats.unpriced_generations.length > 20) stats.unpriced_generations.shift();
}
function recordTurn({ usage, billed, lane, firstMs, genId, whole = false }) {
  stats.turns += 1;
  stats.lanes[lane] = (stats.lanes[lane] || 0) + 1;
  // A writing lane's time is its whole answer, not a first word: kept out of the first-word median.
  if (Number.isFinite(firstMs) && !whole) {
    stats.first_token_ms.push(firstMs);
    if (stats.first_token_ms.length > 200) stats.first_token_ms.shift();
  }
  if (!usage) { unpriced(genId); return; }
  const n = claudeNumbers(usage);
  stats.tokens.prompt += n.prompt;
  stats.tokens.cached += n.cached;
  stats.tokens.cache_write += n.cacheWrite;
  stats.tokens.reply += n.reply;
  stats.tokens.reasoning += n.reasoning;
  addSpend(usage);
  if (usage.is_byok === true) stats.byok_turns += 1;
  if (billed && typeof billed.cost === 'number') stats.billed_as_mimo_usd += billed.cost;
}
function snapshot(env = process.env, now = Date.now()) {
  const s = settings(env);
  const sorted = [...stats.first_token_ms].sort((a, b) => a - b);
  const left = cooldownLeftMs(now);
  const round = (x) => Math.round(x * 1e6) / 1e6;
  const share = stats.tokens.prompt > 0 ? Math.round((stats.tokens.cached / stats.tokens.prompt) * 1000) / 1000 : null;
  let holding = 0;
  for (const v of held.values()) if (v.until > now) holding += 1;
  const warnings = [];
  if (left > 0 && cooldown.reason === 'not_byok') {
    warnings.push('Claude is off: a turn was paid from OpenRouter credit, not her Anthropic key. Check the key in ' +
      'OpenRouter (BYOK, "never use shared capacity"); a deploy turns Claude back on.');
  }
  if (stats.not_byok_turns > 0) warnings.push(`${stats.not_byok_turns} Claude turn(s) since the deploy were paid from OpenRouter credit at list price.`);
  if (stats.turns >= 50 && share !== null && share < 0.5) {
    warnings.push(`Only ${Math.round(share * 100)} percent of the prompt was read from cache over ${stats.turns} turns: ` +
      'past about half missing, the one-hour marks cost more than no marks (see the cost note in claude-route.js).');
  }
  return {
    enabled: s.on, model: s.model, effort: s.effort, max_effort: s.maxEffort, cache_ttl: s.cacheTtl,
    writing_lanes_on: s.on ? [...s.lanes] : [],
    adults_only: s.adultsOnly, byok_only: s.byokOnly, token_ratio: s.tokenRatio, mimo_price_per_million: s.price,
    cooldown: left > 0 ? { reason: cooldown.reason, seconds_left: Math.ceil(left / 1000) } : null,
    conversations_held: holding,
    since: stats.since, turns: stats.turns, lanes: { ...stats.lanes }, fallbacks: { ...stats.fallbacks },
    stayed_on_mimo: { ...stats.skips }, last_fallback: stats.last_fallback,
    first_token_ms_median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    tokens: { ...stats.tokens }, cached_share: share,
    real_cost_usd: round(stats.real_cost_usd), openrouter_usd: round(stats.openrouter_usd),
    anthropic_credit_usd: round(stats.anthropic_credit_usd), billed_as_mimo_usd: round(stats.billed_as_mimo_usd),
    byok_turns: stats.byok_turns, not_byok_turns: stats.not_byok_turns,
    paid_fallbacks: stats.paid_fallbacks, fallback_cost_usd: round(stats.fallback_cost_usd),
    broken_after_first_word: stats.broken_after_first_word, unpriced_generations: [...stats.unpriced_generations],
    warnings,
    note: 'Kept in memory: every deploy starts the totals again; the month lives in the Anthropic console (her ' +
      'credit) and on OpenRouter\'s activity page. real_cost_usd is what the Claude calls really cost, used or ' +
      'not: openrouter_usd came out of OpenRouter credit, anthropic_credit_usd out of her Anthropic credit (only ' +
      'once her key is in OpenRouter). billed_as_mimo_usd is what the website was told, the same turns at MiMo ' +
      'prices. unpriced_generations are calls whose cost never came back on the stream; each can be looked up ' +
      'for free at GET https://openrouter.ai/api/v1/generation?id=<id>.',
  };
}

/* ── failures ───────────────────────────────────────────────────────────── */
function classifyFailure(status, text) {
  const t = String(text || '').slice(0, 20000);
  if (status === 402 || CREDIT_RE.test(t)) return 'credit';
  if (status === 401) return 'key';
  if (status === 403) return FLAGGED_RE.test(t) ? 'flagged' : 'key';
  if (status === 404 || BAD_MODEL_RE.test(t)) return 'bad_model';
  if (status === 429) return 'rate_limit';
  if (status === 504) return 'http_504';
  if (Number.isFinite(status) && status >= 400) return `http_${status}`;
  return 'stream_error';
}
/* One fallback: what it does to the next turns, its line and its count. `state` is the stream's, when
 * Claude had accepted the call: then the call may have been paid, and its generation id is named. */
function fail(reason, { reqId, lane, ms, status, env, log = console.log, now = Date.now(), plan = {}, state = null, alert = null } = {}) {
  if (reason === 'hangup') return { fail: reason };
  const effect = applyFailure(reason, plan, env, now).text;
  stats.fallbacks[reason] = (stats.fallbacks[reason] || 0) + 1;
  stats.last_fallback = { at: new Date(now).toISOString(), reason, lane: lane || null };
  let paid = '';
  if (state && state.genId) {
    stats.paid_fallbacks += 1;
    const real = state.usage ? addSpend(state.usage) : null;
    if (real != null) {
      stats.fallback_cost_usd += real;
      paid = ` gen=${state.genId} cost=$${real.toFixed(6)}`;
    } else {
      unpriced(state.genId);
      paid = ` gen=${state.genId} cost=not reported`;
    }
  }
  const to = reason === 'refusal' && plan.refusalModel ? plan.refusalModel : laneStays(lane);
  log(`[claude][req ${reqId || '??????'}] fallback to ${to}: lane=${lane || '?'} reason=${reason}` +
    `${status ? ` status=${status}` : ''} after ${Number.isFinite(ms) ? ms : '?'}ms${paid} -- ${effect}`);
  if (reason === 'key' && typeof alert === 'function') {
    try { alert('key', `Anthropic refused your key through OpenRouter (status ${status || '?'}). MiMo is answering; Claude is tried again every ${Math.round(settings(env).cooldownMs / 60000)} minutes.`); } catch {}
  }
  return { fail: reason, status };
}
/* THE BYOK GUARD: a Claude turn whose usage does not say is_byok: true was paid from OpenRouter credit. */
function checkByok(state, { reqId, lane, env, log, now, alert }) {
  if (state.byokChecked || !state.usage) return;
  state.byokChecked = true;
  const s = settings(env);
  if (!s.byokOnly || state.usage.is_byok === true) return;
  stats.not_byok_turns += 1;
  const effect = applyFailure('not_byok', {}, env, now).text;
  const real = realCostOf(state.usage);
  log(`[claude][req ${reqId || '??????'}] NOT PAID BY HER ANTHROPIC KEY: OpenRouter credit paid ` +
    `${real != null ? `$${real.toFixed(6)}` : 'an unreported amount'} for this turn (is_byok=${state.usage.is_byok === false ? 'false' : 'missing'}, lane=${lane || '?'}` +
    `${state.genId ? `, gen=${state.genId}` : ''}). ${effect}. Check her Anthropic key in OpenRouter (BYOK, "never use shared capacity"); KADE_CLAUDE_BYOK_ONLY=0 allows it.`);
  if (typeof alert === 'function') {
    try { alert('not_byok', 'A Claude turn was paid from OpenRouter credit, not your Anthropic key. Claude is off for a day; MiMo is answering. Check the Anthropic key in OpenRouter.'); } catch {}
  }
}

/* ── the stream ─────────────────────────────────────────────────────────── */
function stripReasoning(obj) {
  let changed = false;
  for (const c of Array.isArray(obj && obj.choices) ? obj.choices : []) {
    for (const holder of [c && c.delta, c && c.message]) {
      if (!holder || typeof holder !== 'object') continue;
      for (const k of ['reasoning', 'reasoning_content', 'reasoning_details']) {
        if (k in holder) { delete holder[k]; changed = true; }
      }
    }
  }
  return changed;
}
const refusedHere = (choice) => !!choice && (choice.finish_reason === 'content_filter' || choice.native_finish_reason === 'refusal');
/* One SSE event in, one out: reasoning fields gone, usage as MiMo-equivalent, a refusal after words handed on
 * as an error. `state` notes what the event carried (the generation id, the first word, a tool call, an error,
 * a refusal, the usage). */
function transformEvent(raw, state) {
  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    let obj;
    try { obj = JSON.parse(data); } catch { continue; }
    if (!state.provider && obj.provider) state.provider = obj.provider;
    if (!state.model && obj.model) state.model = obj.model;
    if (!state.genId && typeof obj.id === 'string' && obj.id) state.genId = obj.id;
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (obj.error || (choice && choice.finish_reason === 'error')) {
      const e = obj.error || {};
      const metaRaw = e.metadata && e.metadata.raw ? (typeof e.metadata.raw === 'string' ? e.metadata.raw : JSON.stringify(e.metadata.raw)) : '';
      state.error = { code: Number(e.code) || undefined, text: `${e.message || ''} ${metaRaw}`, afterWords: !!(state.text || state.tool) };
    }
    const delta = (choice && choice.delta) || {};
    if (typeof delta.content === 'string' && /\S/.test(delta.content)) state.text = true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) state.tool = true;
    let changed = stripReasoning(obj);
    if (refusedHere(choice)) {
      state.refused = true;
      if (state.text || state.tool) {
        // Words are already out (or held): an "error" finish makes the buffered lane re-ask MiMo
        // instead of serving the start of a refusal as the whole reply.
        state.refusedAfterWords = true;
        choice.finish_reason = 'error';
        changed = true;
      }
    }
    if (obj.usage && typeof obj.usage === 'object') {
      state.usage = obj.usage;
      // A lane billed at Claude's real cost (the lyric desk, billing 'real') hands its usage on as it came.
      if (state.billing !== 'real') {
        obj.usage = mimoEquivalentUsage(obj.usage, state.env, state.model || '');
        state.billed = obj.usage;
        changed = true;
      }
    }
    if (changed) lines[i] = `data: ${JSON.stringify(obj)}`;
  }
  return lines.join('\n');
}
function readWithin(reader, ms) {
  let timer = null;
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('no first word in time'), { name: 'ClaudeTimeout' })), Math.max(0, ms));
  });
  return Promise.race([reader.read(), late]).finally(() => clearTimeout(timer));
}
/* `whole`: a writing lane read to its end before it was handed on, so the time is the whole call's (ms=). */
function turnLine({ reqId, lane, effort, firstMs, state, whole = false }) {
  const gen = state.genId ? ` gen=${state.genId}` : '';
  const how = state.broke ? ' broke=after first word' : state.refusedAfterWords ? ' refused=after words' : state.error ? ' error=after first word' : '';
  const timing = whole ? `ms=${firstMs}` : `first_token_ms=${firstMs}`;
  const u = state.usage;
  if (!u) return `[claude][req ${reqId}] turn lane=${lane} effort=${effort} ${timing}${how} usage=not reported${gen} host=${state.provider || '?'}`;
  const n = claudeNumbers(u);
  const billed = state.billed && typeof state.billed.cost === 'number' ? ` billed_as_mimo=$${state.billed.cost.toFixed(6)}` : '';
  return `[claude][req ${reqId}] turn lane=${lane} effort=${effort} ${timing}${how} prompt=${n.prompt} cached=${n.cached}` +
    ` cache_write=${n.cacheWrite} reply=${n.reply} reasoning=${n.reasoning}${costNote(u) || ' cost=?'}${billed}${gen} host=${state.provider || '?'}`;
}

/* Opens the Claude stream and waits for its first word or tool call. Returns { upstream } -- a stand-in
 * for the fetch Response that handleStreaming reads exactly as it reads a host's own (status 200,
 * text/event-stream, a body reader, events scrubbed and usage re-priced) -- or { fail } after logging
 * the fallback. `fetchFn(url, options, headersTimeoutMs)` is server.js's fetchWithTimeout. `alert(kind,
 * text)` is the admin alert (the BYOK guard and a refused key). */
async function openStream({ body, url, headers, fetchFn, signal, plan, reqId = '??????', lane = '?', env = process.env,
  log = console.log, now = Date.now, quiet = false, alert = null }) {
  const t0 = now();
  const state = { env, text: false, tool: false, error: null, usage: null, billed: null, provider: null, model: null, genId: null,
    billing: plan.billing === 'real' ? 'real' : 'mimo' };
  const guard = () => checkByok(state, { reqId, lane, env, log, now: now(), alert });
  const why = (reason, extra = {}) => {
    guard();
    return fail(reason, { reqId, lane, ms: now() - t0, env, log, now: now(), plan, alert, ...extra });
  };
  if (signal && signal.aborted) return { fail: 'hangup' };
  const ac = new AbortController();
  const onHangup = () => ac.abort();
  if (signal) signal.addEventListener('abort', onHangup, { once: true });
  const detach = () => { if (signal) signal.removeEventListener('abort', onHangup); };
  let res;
  try {
    /* A writing lane's limit is for its whole answer; the host's headers still come at once (OpenRouter answers 200
     * before the model thinks). Kept under server.js's LONG_FETCH_MS so the call stays a stream. */
    res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal },
      plan.whole === true ? Math.min(plan.firstTokenMs, WHOLE_HEADERS_MS) : plan.firstTokenMs);
  } catch (e) {
    detach();
    if (signal && signal.aborted) return { fail: 'hangup' };
    return why(e && e.name === 'AbortError' ? 'timeout' : 'network');
  }
  if (!res.ok) {
    let text = '';
    try { text = await res.text(); } catch {}
    detach();
    return why(classifyFailure(res.status, text), { status: res.status });
  }
  if (!String((res.headers && res.headers.get('content-type')) || '').includes('text/event-stream')) {
    try { await res.text(); } catch {}
    detach();
    return why('not_a_stream');
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const stop = () => { try { ac.abort(); } catch {} try { reader.cancel().catch(() => {}); } catch {} };
  let buffer = '';
  let ready = '';
  /* A writing lane (plan.whole) reads the whole answer here, inside its time limit and the idle limit, so any
   * failure up to the last event still falls back with nothing handed on. */
  const whole = plan.whole === true;
  const idleMs = whole ? settings(env).idleMs : 0;
  while (whole || (!state.text && !state.tool)) {
    const left = t0 + plan.firstTokenMs - now();
    let step;
    try {
      if (left <= 0) throw Object.assign(new Error(whole ? 'not finished in time' : 'no first word in time'), { name: 'ClaudeTimeout' });
      step = await readWithin(reader, whole ? Math.min(left, idleMs) : left);
    } catch (e) {
      stop();
      detach();
      if (signal && signal.aborted) return { fail: 'hangup' };
      return why(e && e.name === 'ClaudeTimeout' ? 'timeout' : 'stream_error', { state });
    }
    if (step.done) {
      if (buffer.trim()) ready += transformEvent(buffer, state) + '\n\n';
      buffer = '';
      detach();
      if (state.error) return why(classifyFailure(state.error.code, state.error.text), { status: state.error.code, state });
      if (whole) {
        // Only a finished answer with words in it is handed on; a refusal anywhere in it falls back.
        if (state.refused) return why('refusal', { state });
        if (!state.text && !state.tool) return why('empty', { state });
        break;
      }
      if (state.text || state.tool) break; // the last event was the first word: hand it over
      return why(state.refused ? 'refusal' : 'empty', { state });
    }
    buffer += decoder.decode(step.value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      ready += transformEvent(buffer.slice(0, idx), state) + '\n\n';
      buffer = buffer.slice(idx + 2);
    }
    if (state.error) {
      stop();
      detach();
      return why(classifyFailure(state.error.code, state.error.text), { status: state.error.code, state });
    }
  }
  guard();
  const firstMs = now() - t0;
  const encoder = new TextEncoder();
  let logged = false;
  const report = () => {
    recordTurn({ usage: state.usage, billed: state.billed, lane, firstMs, genId: state.genId, whole });
    log(turnLine({ reqId, lane, effort: plan.effort, firstMs, state, whole }));
  };
  /* After the first word, a broken stream or an error event is a strike, and a refusal holds this
   * conversation; the gateway's own nets decide what the person gets. */
  const afterWords = () => {
    if (state.refusedAfterWords) applyFailure('refusal', plan, env, now());
    else if (state.broke || state.error) {
      stats.broken_after_first_word += 1;
      applyFailure('broke', plan, env, now());
    }
  };
  /* The turn line is written when the stream ends, however it ends. `quiet` (the one-piece route) leaves it
   * to the caller, who knows whether the turn was Claude's in the end. */
  const finish = () => {
    if (logged) return;
    logged = true;
    detach();
    guard();
    if (!quiet) {
      afterWords();
      report();
    }
  };
  let ended = false;
  const stream = new ReadableStream({
    start(controller) {
      if (ready) controller.enqueue(encoder.encode(ready));
    },
    async pull(controller) {
      if (ended) return;
      for (;;) {
        let step;
        try {
          step = await reader.read();
        } catch (e) {
          ended = true;
          if (!(signal && signal.aborted)) state.broke = true;
          finish();
          controller.error(e);
          return;
        }
        if (step.done) {
          const tail = buffer + decoder.decode();
          buffer = '';
          // A last event the host did not close with a blank line still gets one, or no reader would see it.
          if (tail.trim()) controller.enqueue(encoder.encode(transformEvent(tail, state) + '\n\n'));
          ended = true;
          finish();
          controller.close();
          return;
        }
        buffer += decoder.decode(step.value, { stream: true });
        let out = '';
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          out += transformEvent(buffer.slice(0, idx), state) + '\n\n';
          buffer = buffer.slice(idx + 2);
        }
        if (state.usage) guard();
        if (out) {
          controller.enqueue(encoder.encode(out));
          return;
        }
      }
    },
    cancel(reason) {
      ended = true;
      finish();
      try { ac.abort(); } catch {}
      return reader.cancel(reason).catch(() => {});
    },
  });
  return {
    firstMs,
    report,
    state,
    /* For the one-piece route: stop reading; its fallback line says what happened. */
    abandon: () => {
      logged = true;
      ended = true;
      detach();
      try { ac.abort(); } catch {}
      try { reader.cancel().catch(() => {}); } catch {}
    },
    upstream: {
      ok: true,
      status: 200,
      headers: { get: (name) => (/^content-type$/i.test(String(name)) ? 'text/event-stream' : (res.headers ? res.headers.get(name) : null)) },
      body: stream,
      text: async () => '',
    },
  };
}

/* The one-piece route (stream:false callers, the rooms): the same stream read to its end and handed back as
 * one chat.completion. Nothing reaches the person before the end here, so any failure falls back. */
async function complete(opts) {
  const got = await openStream({ ...opts, quiet: true, body: { ...opts.body, stream: true, stream_options: { include_usage: true } } });
  if (!got.upstream) return got;
  const env = opts.env || process.env;
  const t0 = (opts.now || Date.now)();
  const reader = got.upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let finish = null;
  let usage = null;
  let base = null;
  const calls = [];
  /* A refusal or an error after the first word: the turn falls back, but the stream is read on for a moment
   * so the usage that follows it (what the unused call cost) is counted. */
  let broken = null;
  const why = (reason) => fail(reason, { reqId: opts.reqId, lane: opts.lane, ms: (opts.now || Date.now)() - t0 + got.firstMs,
    env, log: opts.log || console.log, plan: opts.plan || {}, state: got.state, alert: opts.alert });
  const take = (raw) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let c;
      try { c = JSON.parse(data); } catch { continue; }
      const ch = Array.isArray(c.choices) ? c.choices[0] : null;
      if (c.error || (ch && ch.finish_reason === 'error')) {
        if (!broken) broken = got.state.refusedAfterWords ? 'refusal' : 'stream_error';
        continue;
      }
      if (broken) continue;
      if (!base) base = c;
      if (c.usage) usage = c.usage;
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (typeof d.content === 'string') content += d.content;
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const at = Number.isInteger(tc.index) ? tc.index : calls.length;
        const slot = calls[at] || (calls[at] = { id: '', type: 'function', function: { name: '', arguments: '' } });
        if (tc.id) slot.id = tc.id;
        if (tc.type) slot.type = tc.type;
        if (tc.function && tc.function.name) slot.function.name += tc.function.name;
        if (tc.function && typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
      }
    }
  };
  try {
    const idleMs = settings(env).idleMs;
    for (;;) {
      const step = await readWithin(reader, broken ? Math.min(idleMs, 1500) : idleMs);
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        take(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
      }
    }
    if (buffer.trim()) take(buffer);
  } catch (e) {
    got.abandon();
    if (opts.signal && opts.signal.aborted) return { fail: 'hangup' };
    return why(broken || (e && e.name === 'ClaudeTimeout' ? 'timeout' : 'stream_error'));
  }
  if (broken) {
    got.abandon();
    if (opts.signal && opts.signal.aborted) return { fail: 'hangup' };
    return why(broken);
  }
  const toolCalls = calls.filter(Boolean);
  if (!content.trim() && !toolCalls.length) return why(got.state.refused ? 'refusal' : 'empty');
  got.report();
  return {
    result: {
      id: base && base.id, object: 'chat.completion', created: base && base.created, model: base && base.model,
      ...(base && base.provider ? { provider: base.provider } : {}),
      choices: [{
        index: 0,
        message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
        finish_reason: toolCalls.length ? 'tool_calls' : (finish || 'stop'),
      }],
      ...(usage ? { usage } : {}),
    },
  };
}

module.exports = {
  DEFAULT_MODEL, DEFAULT_PRICE, ADULT_NOTES, THINK_ROOM, settings, on, audienceOf, softenAdultNotes, conversationKey,
  planTurn, buildBody, withCacheMarks, mimoEquivalentUsage, classifyFailure, scopeOf, applyFailure, noteFailure,
  cooldownLeftMs, conversationHeld, transformEvent, openStream, complete, snapshot, noteSkip, isMimoProModel, resetForTest,
  LANES, LANE_NAMES, isLane, lanesFrom, planLane, laneStays, isClaudeModel,
};
