'use strict';
/* claude-route.js -- CHARACTER CHAT ON CLAUDE, MiMo UNDERNEATH. OFF unless KADE_CLAUDE_CHAT=1.
 *
 * Kade's decision, Nov 13 2026. Her plan includes $200 a month of Claude API credit that renews each
 * billing cycle and does not roll over, so the characters' replies go to Claude Opus 5.5 through
 * OpenRouter, and MiMo picks the turn up the moment Claude cannot answer. Her Anthropic key goes into
 * OpenRouter as a BYOK provider key with "never use shared capacity", so a Claude turn spends her
 * Anthropic credit and never OpenRouter's; until that key is in, a Claude turn is billed to OpenRouter
 * credits at list price ($4 in, $20 out, $0.20 cached read per million tokens).
 *
 * WHICH TURNS. A character chat turn that would have gone to xiaomi/mimo-v2.6-pro: the reply a person
 * reads or hears (website, apps, phone calls, the rooms). server.js decides it on the body exactly as
 * MiMo would have received it, after every adapter, and never for a background run (kade_background),
 * a title, the keeper, a machine lane, a writing desk, a caller's own think deadline, a forced tool
 * choice, a reply prefilled by the caller, or audio and video (MiMo hears them; Claude does not).
 * A turn whose head carries the website's under-15 audience note (child and teen accounts) stays on
 * MiMo: Anthropic expects extra safeguards where minors use a product. An untyped account carries no
 * note either way; KADE_CLAUDE_ADULTS_ONLY=1 keeps everything on MiMo but turns marked "verified adult".
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
 * a voice.
 *
 * PROMPT CACHING. Two marks, both on the stable start of the prompt: the end of the website's system
 * head (Anthropic renders tools first, so this one covers the tool schemas and the persona), and the
 * last message of the history before the person's newest turn. Everything that changes every turn
 * (the website's dynamic tail and memory recall, the person's message, the gateway's own tail with the
 * clock) sits after the second mark. The lifetime is one hour (KADE_CLAUDE_CACHE_TTL=5m for five
 * minutes). Opus 5.5 prices a write at $5 (5 minutes) or $8 (1 hour) a million against $4 plain and
 * $0.20 for a read. On her pattern (people answer minutes apart; about 24,000 of a turn's 29,000 tokens
 * are the stable head) a 5-minute entry is gone whenever a reply takes longer than five minutes, and each
 * miss re-writes the whole head: 24,000 x $5 = 12 cents. The hour costs 7.2 cents more once (24,000 x $3
 * extra) and then reads for 0.5 cents while the gap stays under an hour. A ten-turn chat where three
 * replies come 5-60 minutes apart: 5-minute entries about 51 cents of head, 1-hour entries about 24 cents.
 * Only a chat whose every reply comes inside five minutes is cheaper on 5 minutes (16 cents against 24).
 * The gateway's own tail (style reminder, lane note, clock: about 2,900 Claude tokens) is read at the
 * plain price every turn, because the clock in it moves every minute.
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
 * TOKEN_MS 20000, never past the turn's own think deadline) or an empty reply sends the same turn to
 * MiMo at once, with one log line. A credit-balance answer skips Claude for KADE_CLAUDE_COOLDOWN_MIN (30)
 * minutes, any other failure for KADE_CLAUDE_ERROR_COOLDOWN_MIN (2). After the first word the gateway's
 * own nets (the truncation re-ask, the stall notice) handle a broken stream, on the MiMo body. The
 * one-piece route (stream:false, the rooms) reads Claude's stream to the end, waiting at most
 * KADE_CLAUDE_IDLE_MS (30000) between events, and falls back on any failure, since nothing has reached
 * the person yet. Claude's max_tokens is at least KADE_CLAUDE_MIN_TOKENS (8000): thinking shares it.
 *
 * MONEY. The website bills a chat turn from the usage this gateway hands back: token counts priced at
 * its MiMo row (packages/data-schemas tx.ts) on the agent path, `usage.cost` on the rooms. So a Claude
 * turn hands back MiMo-equivalent usage: the reply's own tokens (thinking left out, MiMo never thought
 * on that turn), the counts divided by KADE_CLAUDE_TOKEN_RATIO (Claude's tokenizer counts more tokens
 * for the same words), and `cost` at the MiMo price (KADE_CLAUDE_MIMO_PRICE, $ per million in, out and
 * cached read, default the website's row 0.435,0.87,0.0036). Nobody is charged more than MiMo would have
 * cost. The real Claude numbers ride along in usage.kade_claude, in one [claude] log line per turn, and
 * in GET /claude-spend (totals since the last deploy).
 *
 * Every switch is read per call, so changing a Railway variable is enough (no code change). KADE_CLAUDE_CHAT
 * unset or 0: nothing in this file runs and every body leaves exactly as before, byte for byte
 * (claude-route-off-wire.test.js holds that against origin/main). */

const { ReadableStream } = require('node:stream/web');
const { realCostOf, costNote } = require('./usage-cost');
const { carriesMedia } = require('./mimo');

const DEFAULT_MODEL = 'anthropic/claude-opus-5.5';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
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
const ADULT_MARK = 'verified adult';
const CREDIT_RE = /credit balance|purchase credits|insufficient[ _]credits|more credits|payment required|billing/i;
/* Fields OpenRouter would pass on to Anthropic that Opus 5.5 refuses or that belong to MiMo's route. */
const DROP = ['models', 'provider', 'reasoning', 'reasoning_effort', 'include_reasoning', 'temperature', 'top_p',
  'top_k', 'top_a', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed', 'logit_bias',
  'logprobs', 'top_logprobs', 'transforms', 'route', 'max_completion_tokens', 'verbosity'];

const isMimoProModel = (model) => /^(?:xiaomi\/)?mimo-v2\.6-pro$/i.test(String(model || ''));

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

function settings(env = process.env) {
  return {
    on: String(env.KADE_CLAUDE_CHAT ?? '').trim() === '1',
    model: String(env.KADE_CLAUDE_MODEL ?? '').trim() || DEFAULT_MODEL,
    effort: effortWord(env.KADE_CLAUDE_EFFORT, 'low'),
    maxEffort: effortWord(env.KADE_CLAUDE_MAX_EFFORT, 'medium'),
    cooldownMs: num(env.KADE_CLAUDE_COOLDOWN_MIN, 30, 0) * 60000,
    errorCooldownMs: num(env.KADE_CLAUDE_ERROR_COOLDOWN_MIN, 2, 0) * 60000,
    firstTokenMs: num(env.KADE_CLAUDE_FIRST_TOKEN_MS, 12000, 100),
    callFirstTokenMs: num(env.KADE_CLAUDE_CALL_FIRST_TOKEN_MS, 8000, 100),
    thinkFirstTokenMs: num(env.KADE_CLAUDE_THINK_FIRST_TOKEN_MS, 20000, 100),
    idleMs: num(env.KADE_CLAUDE_IDLE_MS, 30000, 100),
    cacheTtl: String(env.KADE_CLAUDE_CACHE_TTL ?? '').trim().toLowerCase() === '5m' ? '5m' : '1h',
    adultsOnly: String(env.KADE_CLAUDE_ADULTS_ONLY ?? '').trim() === '1',
    minTokens: num(env.KADE_CLAUDE_MIN_TOKENS, 8000, 1),
    tokenRatio: Math.max(1, num(env.KADE_CLAUDE_TOKEN_RATIO, DEFAULT_RATIO, 0.01)),
    price: priceFrom(env.KADE_CLAUDE_MIMO_PRICE),
  };
}
const on = (env = process.env) => settings(env).on;

/* ── who is talking ─────────────────────────────────────────────────────── */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (p && p.type === 'text' && typeof p.text === 'string' ? p.text : '')).join('\n');
}
/* 'child' when the head carries the website's under-15 note (child and teen accounts, the agent path and
 * the rooms), 'adult' when it carries the verified-adult note, 'unmarked' otherwise. */
function audienceOf(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  let adult = false;
  for (const m of msgs) {
    if (!m || (m.role !== 'system' && m.role !== 'developer')) continue;
    const t = textOf(m.content).toLowerCase();
    if (CHILD_MARKS.some((mark) => t.includes(mark))) return 'child';
    if (t.includes(ADULT_MARK)) adult = true;
  }
  return adult ? 'adult' : 'unmarked';
}

/* ── the cooldown ───────────────────────────────────────────────────────── */
const cooldown = { until: 0, reason: '' };
function cooldownLeftMs(now = Date.now()) {
  return Math.max(0, cooldown.until - now);
}
function noteFailure(reason, env = process.env, now = Date.now()) {
  if (reason === 'hangup') return 0;
  const s = settings(env);
  const ms = reason === 'credit' ? s.cooldownMs : s.errorCooldownMs;
  if (now + ms > cooldown.until) {
    cooldown.until = now + ms;
    cooldown.reason = reason;
  }
  return ms;
}
function resetForTest() {
  cooldown.until = 0;
  cooldown.reason = '';
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
 *   personLane      the turn is a conversation (not JSON, a desk, a title, the keeper, a machine lane)
 *   background      kade_background / x-kade-background
 *   shimActive      the tool shim rewrote the body
 *   callerDeadline  the caller sent its own kade_think_deadline_ms
 *   phone           a call turn
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
  if (s.adultsOnly && audience !== 'adult') return { skip: 'not marked as an adult (KADE_CLAUDE_ADULTS_ONLY=1)' };
  const left = cooldownLeftMs(now);
  if (left > 0) return { skip: `Claude cooling down after ${cooldown.reason}, ${Math.ceil(left / 1000)} s left` };
  const r = (wire.reasoning && typeof wire.reasoning === 'object') ? wire.reasoning : {};
  const thinking = r.enabled === true;
  const effort = thinking ? lowerEffort(effortWord(r.effort, 'medium'), s.maxEffort) : s.effort;
  let firstTokenMs = ctx.phone ? s.callFirstTokenMs : thinking ? s.thinkFirstTokenMs : s.firstTokenMs;
  if (Number.isFinite(ctx.deadlineLeftMs)) firstTokenMs = Math.min(firstTokenMs, Math.max(1000, ctx.deadlineLeftMs - 500));
  return { model: s.model, effort, thinking, firstTokenMs, ttl: s.cacheTtl, minTokens: s.minTokens };
}

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
/* Mark 1: the system head (with the tools Anthropic renders before it). Mark 2: the last message of the
 * history before the person's newest run of messages (the website's dynamic tail, the person's words
 * and the recall blobs all ride as user messages in that run, and the gateway's tail comes after it). */
function withCacheMarks(messages, ttl = '1h') {
  if (!Array.isArray(messages)) return messages;
  const mark = ttl === '5m' ? { type: 'ephemeral' } : { type: 'ephemeral', ttl: '1h' };
  const out = messages.map(unmarked);
  let head = -1;
  if (out[0] && (out[0].role === 'system' || out[0].role === 'developer') && hasText(out[0].content)) {
    out[0] = marked(out[0], mark);
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
        out[j] = marked(m, mark);
        break;
      }
    }
  }
  return out;
}
function buildBody(wire, plan) {
  const out = {};
  for (const [k, v] of Object.entries(wire)) if (!DROP.includes(k)) out[k] = v;
  out.model = plan.model;
  out.provider = { only: ['anthropic'], allow_fallbacks: false };
  out.reasoning = { effort: plan.effort, exclude: true };
  const asked = Number(wire.max_tokens ?? wire.max_completion_tokens);
  out.max_tokens = Number.isFinite(asked) && asked > plan.minTokens ? asked : plan.minTokens;
  out.messages = withCacheMarks(wire.messages, plan.ttl);
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
    byok_turns: 0, first_token_ms: [], last_fallback: null,
  };
}
const stats = freshStats();
function noteSkip(reason) {
  const key = String(reason).replace(/,.*$/, '');
  stats.skips[key] = (stats.skips[key] || 0) + 1;
}
function recordTurn({ usage, billed, lane, firstMs }) {
  stats.turns += 1;
  stats.lanes[lane] = (stats.lanes[lane] || 0) + 1;
  if (Number.isFinite(firstMs)) {
    stats.first_token_ms.push(firstMs);
    if (stats.first_token_ms.length > 200) stats.first_token_ms.shift();
  }
  if (!usage) return;
  const n = claudeNumbers(usage);
  stats.tokens.prompt += n.prompt;
  stats.tokens.cached += n.cached;
  stats.tokens.cache_write += n.cacheWrite;
  stats.tokens.reply += n.reply;
  stats.tokens.reasoning += n.reasoning;
  const real = realCostOf(usage);
  if (real != null) stats.real_cost_usd += real;
  // OpenRouter's own `cost` is paid from OpenRouter credit (the whole price, or only its fee with BYOK);
  // with BYOK the rest is what Anthropic charged her key.
  if (typeof usage.cost === 'number') stats.openrouter_usd += usage.cost;
  if (usage.is_byok === true) {
    stats.byok_turns += 1;
    if (real != null && typeof usage.cost === 'number') stats.anthropic_credit_usd += real - usage.cost;
  }
  if (billed && typeof billed.cost === 'number') stats.billed_as_mimo_usd += billed.cost;
}
function snapshot(env = process.env, now = Date.now()) {
  const s = settings(env);
  const sorted = [...stats.first_token_ms].sort((a, b) => a - b);
  const left = cooldownLeftMs(now);
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return {
    enabled: s.on, model: s.model, effort: s.effort, max_effort: s.maxEffort, cache_ttl: s.cacheTtl,
    adults_only: s.adultsOnly, token_ratio: s.tokenRatio, mimo_price_per_million: s.price,
    cooldown: left > 0 ? { reason: cooldown.reason, seconds_left: Math.ceil(left / 1000) } : null,
    since: stats.since, turns: stats.turns, lanes: { ...stats.lanes }, fallbacks: { ...stats.fallbacks },
    stayed_on_mimo: { ...stats.skips }, last_fallback: stats.last_fallback,
    first_token_ms_median: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    tokens: { ...stats.tokens },
    real_cost_usd: round(stats.real_cost_usd), openrouter_usd: round(stats.openrouter_usd),
    anthropic_credit_usd: round(stats.anthropic_credit_usd), billed_as_mimo_usd: round(stats.billed_as_mimo_usd),
    byok_turns: stats.byok_turns,
    note: 'Kept in memory: every deploy starts the totals again. real_cost_usd is what the Claude turns really ' +
      'cost: openrouter_usd came out of OpenRouter credit, anthropic_credit_usd out of her Anthropic credit (only ' +
      'once her key is in OpenRouter). billed_as_mimo_usd is what the website was told, the same turns at MiMo prices.',
  };
}

/* ── failures ───────────────────────────────────────────────────────────── */
function classifyFailure(status, text) {
  const t = String(text || '').slice(0, 20000);
  if (status === 402 || CREDIT_RE.test(t)) return 'credit';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (Number.isFinite(status) && status >= 400) return `http_${status}`;
  return 'stream_error';
}
function fail(reason, { reqId, lane, ms, status, env, log = console.log, now = Date.now() } = {}) {
  if (reason === 'hangup') return { fail: reason };
  const skipMs = noteFailure(reason, env, now);
  stats.fallbacks[reason] = (stats.fallbacks[reason] || 0) + 1;
  stats.last_fallback = { at: new Date(now).toISOString(), reason, lane: lane || null };
  log(`[claude][req ${reqId || '??????'}] fallback to MiMo: lane=${lane || '?'} reason=${reason}` +
    `${status ? ` status=${status}` : ''} after ${Number.isFinite(ms) ? ms : '?'}ms -- Claude skipped for ${Math.round(skipMs / 6000) / 10} min`);
  return { fail: reason, status };
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
/* One SSE event in, one out: reasoning fields gone, usage as MiMo-equivalent. `state` notes what the
 * event carried (the first word, a tool call, an error, the usage). */
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
    const choice = Array.isArray(obj.choices) ? obj.choices[0] : null;
    if (obj.error || (choice && choice.finish_reason === 'error')) {
      const e = obj.error || {};
      const metaRaw = e.metadata && e.metadata.raw ? (typeof e.metadata.raw === 'string' ? e.metadata.raw : JSON.stringify(e.metadata.raw)) : '';
      state.error = { code: Number(e.code) || undefined, text: `${e.message || ''} ${metaRaw}` };
    }
    const delta = (choice && choice.delta) || {};
    if (typeof delta.content === 'string' && /\S/.test(delta.content)) state.text = true;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) state.tool = true;
    let changed = stripReasoning(obj);
    if (obj.usage && typeof obj.usage === 'object') {
      state.usage = obj.usage;
      obj.usage = mimoEquivalentUsage(obj.usage, state.env, state.model || '');
      state.billed = obj.usage;
      changed = true;
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
function turnLine({ reqId, lane, effort, firstMs, state }) {
  const u = state.usage;
  if (!u) return `[claude][req ${reqId}] turn lane=${lane} effort=${effort} first_token_ms=${firstMs} usage=not reported host=${state.provider || '?'}`;
  const n = claudeNumbers(u);
  const billed = state.billed && typeof state.billed.cost === 'number' ? ` billed_as_mimo=$${state.billed.cost.toFixed(6)}` : '';
  return `[claude][req ${reqId}] turn lane=${lane} effort=${effort} first_token_ms=${firstMs} prompt=${n.prompt} cached=${n.cached}` +
    ` cache_write=${n.cacheWrite} reply=${n.reply} reasoning=${n.reasoning}${costNote(u) || ' cost=?'}${billed} host=${state.provider || '?'}`;
}

/* Opens the Claude stream and waits for its first word or tool call. Returns { upstream } -- a stand-in
 * for the fetch Response that handleStreaming reads exactly as it reads a host's own (status 200,
 * text/event-stream, a body reader, events scrubbed and usage re-priced) -- or { fail } after logging
 * the fallback. `fetchFn(url, options, headersTimeoutMs)` is server.js's fetchWithTimeout. */
async function openStream({ body, url, headers, fetchFn, signal, plan, reqId = '??????', lane = '?', env = process.env,
  log = console.log, now = Date.now, quiet = false }) {
  const t0 = now();
  const why = (reason, extra = {}) => fail(reason, { reqId, lane, ms: now() - t0, env, log, now: now(), ...extra });
  if (signal && signal.aborted) return { fail: 'hangup' };
  const ac = new AbortController();
  const onHangup = () => ac.abort();
  if (signal) signal.addEventListener('abort', onHangup, { once: true });
  const detach = () => { if (signal) signal.removeEventListener('abort', onHangup); };
  let res;
  try {
    res = await fetchFn(url, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal }, plan.firstTokenMs);
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
  const state = { env, text: false, tool: false, error: null, usage: null, billed: null, provider: null, model: null };
  const stop = () => { try { ac.abort(); } catch {} try { reader.cancel().catch(() => {}); } catch {} };
  let buffer = '';
  let ready = '';
  while (!state.text && !state.tool) {
    const left = t0 + plan.firstTokenMs - now();
    let step;
    try {
      if (left <= 0) throw Object.assign(new Error('no first word in time'), { name: 'ClaudeTimeout' });
      step = await readWithin(reader, left);
    } catch (e) {
      stop();
      detach();
      if (signal && signal.aborted) return { fail: 'hangup' };
      return why(e && e.name === 'ClaudeTimeout' ? 'timeout' : 'stream_error');
    }
    if (step.done) {
      if (buffer.trim()) ready += transformEvent(buffer, state) + '\n\n';
      buffer = '';
      detach();
      if (state.error) return why(classifyFailure(state.error.code, state.error.text), { status: state.error.code });
      if (state.text || state.tool) break; // the last event was the first word: hand it over
      return why('empty');
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
      return why(classifyFailure(state.error.code, state.error.text), { status: state.error.code });
    }
  }
  const firstMs = now() - t0;
  const encoder = new TextEncoder();
  let logged = false;
  const report = () => {
    recordTurn({ usage: state.usage, billed: state.billed, lane, firstMs });
    log(turnLine({ reqId, lane, effort: plan.effort, firstMs, state }));
  };
  /* The turn line is written when the stream ends, however it ends. `quiet` (the one-piece route) leaves it
   * to the caller, who knows whether the turn was Claude's in the end. */
  const finish = () => {
    if (logged) return;
    logged = true;
    detach();
    if (!quiet) report();
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
  const why = (reason) => fail(reason, { reqId: opts.reqId, lane: opts.lane, ms: (opts.now || Date.now)() - t0 + got.firstMs,
    env, log: opts.log || console.log });
  const take = (raw) => {
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let c;
      try { c = JSON.parse(data); } catch { continue; }
      const ch = Array.isArray(c.choices) ? c.choices[0] : null;
      if (c.error || (ch && ch.finish_reason === 'error')) throw Object.assign(new Error('stream error'), { name: 'ClaudeStreamError' });
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
      const step = await readWithin(reader, idleMs);
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
    return why(e && e.name === 'ClaudeTimeout' ? 'timeout' : 'stream_error');
  }
  const toolCalls = calls.filter(Boolean);
  if (!content.trim() && !toolCalls.length) return why('empty');
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
  DEFAULT_MODEL, DEFAULT_PRICE, settings, on, audienceOf, planTurn, buildBody, withCacheMarks, mimoEquivalentUsage,
  classifyFailure, noteFailure, cooldownLeftMs, transformEvent, openStream, complete, snapshot, noteSkip,
  isMimoProModel, resetForTest,
};
