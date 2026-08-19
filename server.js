/**
 * server.js — reframe-proxy
 *
 * Sits between LibreChat and OpenRouter as an OpenAI-compatible custom
 * endpoint. Two jobs, both aimed at the AI-slop tics in Kiana's Section 2:
 *
 * 1. REQUEST side: appends a short style reminder as the last message before
 *    forwarding to OpenRouter (recency-decay fix — see appendReminder()).
 * 2. RESPONSE side: runs two deterministic detectors against the full reply
 *    (reframe-filter.js + slop-filter.js). If anything trips, fires ONE
 *    targeted rewrite call before handing the cleaned reply to LibreChat.
 *
 * STREAMING REWORK (June 2026):
 *   Slop detection/rewrite fundamentally needs the FULL prose reply — you
 *   cannot retroactively rewrite text already streamed to the user. So the
 *   proxy treats the two kinds of model turn differently:
 *
 *     - TOOL-CALL turns  -> streamed THROUGH live, byte-for-byte, the instant
 *       tool_calls appear. These are the slow part of a long multi-tool turn
 *       (e.g. "generate 100 images"), and tool-call args are not user-facing
 *       prose, so there is nothing to slop-detect. Streaming them gives the
 *       user real progress visibility round-by-round instead of dead air.
 *     - CONTENT turns    -> buffered fully, detectors run, optional rewrite,
 *       then emitted. Final prose is fast to generate, so buffering it costs
 *       almost nothing while preserving the whole point of this proxy.
 *
 *   Non-streaming callers (stream:false — e.g. Kiana, who runs
 *   disableStreaming:true) hit the ORIGINAL buffered path unchanged. The
 *   streaming behaviour above only engages when the caller asks for
 *   stream:true, so Kiana's path carries zero new risk from this rework.
 *
 *   Known minor tradeoff: in a rare mixed turn (a short prose preamble that
 *   is then followed by a tool_call in the SAME model response), the moment
 *   tool_calls appear the proxy flips to live passthrough and that preamble
 *   is not slop-rewritten. Mixed turns are uncommon and the preamble is
 *   short; accepted for this version.
 *
 * REASONING PASSTHROUGH (June 2026):
 *   librechat.yaml's addParams.reasoning.exclude is now false, so OpenRouter
 *   sends `delta.reasoning` (or `delta.reasoning_content`) chunks ahead of
 *   the real content. These are forwarded LIVE the instant they arrive,
 *   completely separate from the buffered content channel above -- never
 *   accumulated into contentAccum, never touched by slop-detection, and
 *   never present in the final assistant message.content. This both kills
 *   the dead-air window that caused the AgentStream "Job not found" hangs
 *   (real bytes now flow continuously during long xhigh-effort thinking) and
 *   feeds LibreChat's native collapsible "thinking" bubble UI. Because
 *   reasoning text never enters message.content, TTS (which only reads
 *   message.content) never reads it aloud -- that was the original reason
 *   reasoning got excluded entirely; this fixes it properly instead of
 *   blunt-force suppressing it.
 *
 * Auth: LibreChat sends a proxy-only shared secret as its "apiKey". The real
 * OpenRouter key lives only here. Anything without the secret gets 401 before
 * any OpenRouter credit is spent.
 */

'use strict';

const express = require('express');
const crypto = require('crypto');
const { detect } = require('./reframe-filter');
const { detectSlop } = require('./slop-filter');

const PORT = process.env.PORT || 8080;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const PROXY_SHARED_SECRET = process.env.PROXY_SHARED_SECRET;
const REFRAME_LEVEL = process.env.REFRAME_LEVEL || 'balanced';
const OPENROUTER_BASE = process.env.OPENROUTER_BASE || 'https://openrouter.ai/api/v1';
// -- Moonshot / Kimi direct routing (July 21 2026) ---------------------------
// OpenRouter's Kimi hosting is thin/unreliable (live-seen: empty responses on
// moonshotai/kimi-k2.6). Models in KIMI_MODEL_MAP are routed STRAIGHT to
// Moonshot's own API instead, transparently -- LibreChat still thinks it's
// talking to the OpenRouter endpoint, agents keep provider "OpenRouter".
const MOONSHOT_KEY = process.env.MOONSHOT_KEY || '';
const MOONSHOT_BASE = process.env.MOONSHOT_BASE || 'https://api.moonshot.ai/v1';

if (!OPENROUTER_KEY) {
  console.error('FATAL: OPENROUTER_KEY env var is not set.');
  process.exit(1);
}
if (!PROXY_SHARED_SECRET) {
  console.error('FATAL: PROXY_SHARED_SECRET env var is not set.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// -- auth guard for everything except /health --------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const auth = req.headers['authorization'] || '';
  const ok = auth === `Bearer ${PROXY_SHARED_SECRET}`;
  if (!ok) {
    return res.status(401).json({ error: { message: 'Unauthorized' } });
  }
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'reframe-proxy', reframeLevel: REFRAME_LEVEL });
});

// -- model list passthrough --------------------------------------------------
app.get('/models', async (req, res) => {
  try {
    const upstream = await fetch(`${OPENROUTER_BASE}/models`, {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
    });
    const body = await upstream.text();
    res.status(upstream.status).set('Content-Type', 'application/json').send(body);
  } catch (err) {
    console.error('models passthrough error:', err.message);
    res.status(502).json({ error: { message: 'Upstream models fetch failed' } });
  }
});

// -- timeout-guarded OpenRouter calls (non-streaming) ------------------------
const REQUEST_TIMEOUT_MS = 90_000;

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}


// -- friendly out-of-credits error -------------------------------------------
// When the OpenRouter account runs dry it returns HTTP 402 with "Insufficient
// credits" and a link to openrouter.ai. Users don't know what OpenRouter is
// and think THEY broke something or owe money. Rewrite any credit/payment-
// shaped upstream error into plain language that points them at Kade instead.
const OUT_OF_CREDITS_MESSAGE =
  "Kade-AI is out of AI credits right now, so I can't answer just yet. " +
  "Nothing is wrong on your end and there is nothing you need to fix or pay for. " +
  "Please let Kade know the site needs more credits. Once she tops it up, " +
  "just send your message again — all of your conversations are saved.";

function friendlyErrorBody(status, rawText) {
  const raw = String(rawText || '');
  if (status === 402 || /insufficient credits|payment required|credit balance|more credits/i.test(raw)) {
    return JSON.stringify({
      error: { message: OUT_OF_CREDITS_MESSAGE, type: 'insufficient_credits', code: 402 },
    });
  }
  // July 30 2026: if a turn STILL dies after the transient retries, say it
  // like a person instead of piping Moonshot's raw 429 into a scary trace.
  if (status === 429 || status === 503 || /overloaded|rate limit/i.test(raw)) {
    return JSON.stringify({
      error: {
        message:
          'The thinking engine is jammed up right now -- it happens when things get busy. Give it a few seconds and ask again; your question was not lost.',
        type: 'upstream_overloaded',
        code: status || 429,
      },
    });
  }
  return null;
}

function openRouterHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://kademurdock.com',
    'X-Title': 'Kade-AI',
  };
}

// Picker string (left side, OpenRouter-style, what agents are configured with)
// -> Moonshot's own model name. Bare names included so the map is idempotent
// (adaptForKimi may see an already-rewritten body on retry paths).
const KIMI_MODEL_MAP = {
  'moonshotai/kimi-k2.6': 'kimi-k2.6',
  'moonshotai/kimi-k3': 'kimi-k3',
  'kimi-k2.6': 'kimi-k2.6',
  'kimi-k3': 'kimi-k3',
};
function isKimiModel(model) {
  return Object.prototype.hasOwnProperty.call(KIMI_MODEL_MAP, String(model || '').toLowerCase());
}
/* -- WHICH MODELS CAN THINK (Aug 17 2026, Part 72) ---------------------------
 * The fleet moved off Moonshot: 221 of 223 agents now run z-ai/glm-5.2 (only
 * Describe-It and Whittney stay on kimi, for vision). Auto-think had been
 * gated on isKimiModel() since it was built, so the moment the sweep landed
 * EVERY agent logged `[auto-think] skip: non-kimi model (z-ai/glm-5.2)` and
 * the whole router went dark -- no tiering, no "think hard", nothing. Her
 * words: "auto think has really saved Kiana's ass... I like that it chooses
 * different levels of reasoning."
 *
 * GLM-5.2 is a reasoning model too, and measured BETTER behaved than K3 on
 * the toggle (Aug 17, live against OpenRouter with her real 34K persona):
 *   quick  {effort:'low',enabled}  -> 1871ch content, 110 reasoning tokens,  9.7s
 *   deep   {enabled:true}          -> 1854ch content, 230 reasoning tokens, 16.6s
 *   medium                         -> 1401ch content, 172 reasoning tokens, 16.3s
 *   high                           -> 1712ch content, 163 reasoning tokens, 12.9s
 * All four returned real content with finish=stop. (K3 through OpenRouter
 * ignores reasoning-off entirely -- see MODEL_GRIEVANCES_LOG.)
 *
 * ONE REAL TRAP FOUND, and it is why adaptForGlm exists below: with NO
 * reasoning field at all, the "Morph" provider burned 1,037 reasoning tokens,
 * returned ZERO content, finish=length, 97 SECONDS, $0.0127 -- the exact
 * wordless-turn signature the kimi lane already had a net for. */
const GLM_MODEL_RE = /^z-ai\/glm/i;
function isGlmModel(model) {
  return GLM_MODEL_RE.test(String(model || ''));
}
function isReasoningModel(model) {
  return isKimiModel(model) || isGlmModel(model);
}
/* adaptForGlm: the kimi lane gets its max_tokens floored when reasoning is on
 * (adaptForKimi, 8000/16000) precisely so deliberation can't eat the whole
 * budget and hand the person a wordless turn. GLM had no such floor because
 * nothing but kimi ever thought here. GLM's reasoning is far cheaper than
 * K3's (110-230 tokens vs thousands), so the floor is correspondingly small --
 * but a 900-token cap against a 1,037-token think is exactly how you get zero
 * content, so the floor is real. Only binds turns that are ALREADY thinking;
 * instant turns are untouched, so the fast lane's cost is unchanged.
 * Kill/tune: KADE_GLM_THINK_MIN_TOKENS. */
const GLM_THINK_MIN_TOKENS = Number(process.env.KADE_GLM_THINK_MIN_TOKENS || 4000);
function adaptForGlm(body) {
  if (!body || !isGlmModel(body.model)) return body;
  const r = body.reasoning || {};
  const effort = typeof r.effort === 'string' ? r.effort.toLowerCase() : '';
  const thinking = r.enabled === true || ['low', 'medium', 'high'].includes(effort);
  if (!thinking) return body;
  const mt = Number(body.max_tokens);
  if (Number.isFinite(mt) && mt >= GLM_THINK_MIN_TOKENS) return body;
  return { ...body, max_tokens: GLM_THINK_MIN_TOKENS };
}
function chatCompletionsUrl(model) {
  return isKimiModel(model) ? `${MOONSHOT_BASE}/chat/completions` : `${OPENROUTER_BASE}/chat/completions`;
}
function chatHeaders(model) {
  if (isKimiModel(model)) {
    return { Authorization: `Bearer ${MOONSHOT_KEY}`, 'Content-Type': 'application/json' };
  }
  return openRouterHeaders();
}

// -- MOONSHOT BALANCE FALLBACK (Aug 4 2026, Kade: "maybe we should bounce to
// open router if moonshot runs out") -----------------------------------------
// When Moonshot answers a kimi call with an auth/payment-class status (401/
// 402/403 -- an empty balance surfaces in this class), the SAME request is
// retried ONCE against OpenRouter's own kimi hosting so the fleet degrades
// instead of dying. OpenRouter's kimi hosts are thinner (that's WHY direct is
// primary), but a slower answer beats a dead family platform. The model name
// maps back from Moonshot's bare form to the OpenRouter string, and the log
// line is LOUD on purpose -- chronic fallback means one thing: TOP UP THE
// MOONSHOT BALANCE at platform.moonshot.ai.
const MOONSHOT_FALLBACK_STATUSES = new Set([401, 402, 403]);
const OPENROUTER_KIMI_NAMES = {
  'kimi-k2.6': 'moonshotai/kimi-k2.6',
  'kimi-k3': 'moonshotai/kimi-k3',
  'moonshotai/kimi-k2.6': 'moonshotai/kimi-k2.6',
  'moonshotai/kimi-k3': 'moonshotai/kimi-k3',
};
function moonshotFallbackBody(body) {
  const orModel = OPENROUTER_KIMI_NAMES[String(body.model || '').toLowerCase()];
  if (!orModel) return null;
  return { ...body, model: orModel };
}
function shouldFallbackToOpenRouter(model, status) {
  return isKimiModel(model) && MOONSHOT_FALLBACK_STATUSES.has(status);
}

// adaptForKimi: Moonshot HARD-validates temperature against reasoning mode
// (verified live July 21 2026): reasoning ON accepts ONLY temperature 1;
// reasoning_effort:"none" accepts ONLY temperature 0.6. Any other combo 400s.
// So whatever temperature LibreChat/agents send is REPLACED here, and the
// OpenRouter-style `reasoning` object (set by withReasoningIncluded: Deep
// Think marker -> effort high, phone -> effort none, default -> no effort)
// is translated to Moonshot's reasoning_effort. Default is reasoning OFF
// (fast ~5s workhorse turns); a fresh Deep Think marker or an agent-level
// effort setting turns reasoning ON for that turn. With reasoning ON the
// model spends hundreds of reasoning_tokens BEFORE content, so max_tokens is
// floored at 3000 or content comes back empty (also verified live).
function adaptForKimi(body) {
  if (!isKimiModel(body.model)) return body;
  const next = { ...body, model: KIMI_MODEL_MAP[String(body.model).toLowerCase()] };
  // Aug 5 2026 -- THE ARRAY-ASSISTANT BUG, fixed at the last hop (receipts in
  // PROJECT_STATUS Part 13): @langchain/openai flattens all-text USER content
  // arrays to plain strings upstream but passes ASSISTANT and SYSTEM arrays
  // through untouched, and the agents package re-normalizes content to parts
  // internally -- a fork-side pre-flatten provably fired ("kade array-assistant
  // flatten: 1 message(s)") while the wire STILL carried the array. Kimi's chat
  // template effectively skips array-shaped assistant turns: live byte-proof
  // was soft follow-ups getting the PREVIOUS reply repeated BYTE-IDENTICAL
  // (1344ch + completion=342 twice; reproduced across two convos), and the
  // ~90ch JSON scaffold is per-turn byte-noise against Moonshot's prefix
  // cache. Nothing rewrites the body after this function, so the flatten holds
  // here: assistant/system content arrays whose parts are all text join to one
  // plain string (the canonical OpenAI form). User arrays stay untouched
  // (image parts must survive).
  if (Array.isArray(next.messages)) {
    next.messages = next.messages.map((m) => {
      if (
        m &&
        (m.role === 'assistant' || m.role === 'system') &&
        Array.isArray(m.content) &&
        m.content.length > 0 &&
        m.content.every((p) => p && p.type === 'text' && typeof p.text === 'string')
      ) {
        return { ...m, content: m.content.map((p) => p.text).join('\n').trim() };
      }
      return m;
    });
    /* Aug 6 2026 — THE TAGGED-REPLY PRE-SCRUB (Part 12's queued "nibbler"
     * fix, idea 2 in PLATFORM_IMPROVEMENT_IDEAS_2026-08-06). The recorded
     * receipt: a steering-tagged assistant reply re-rendered in history one
     * turn late (1010ch → 919ch = exactly the tag), costing a prefix-cache
     * break at that seat on its second appearance. The cure is uniformity at
     * THE choke point (nothing rewrites the body after adaptForKimi): every
     * assistant HISTORY message is scrubbed of complete %%%…%%% spans on
     * EVERY render, so its bytes are identical from its first appearance to
     * its hundredth. The model never needed its own past stage directions
     * (the platform note teaches the convention fresh each turn); TTS and
     * the fork read the SAVED message, which keeps its tags — this touches
     * only what Moonshot sees. Sloppy 2-4-percent variants normalize first
     * (same tolerance the response path applies), then whole spans lift out;
     * a dangling unclosed opener is left alone (eating real text is worse
     * than one odd render). Kill switch: KADE_HISTORY_PRESCRUB=0. */
    if (process.env.KADE_HISTORY_PRESCRUB !== '0') {
      let scrubbed = 0;
      next.messages = next.messages.map((m) => {
        if (!m || m.role !== 'assistant' || typeof m.content !== 'string' || m.content.indexOf('%%') === -1) {
          return m;
        }
        const before = m.content;
        const after = before
          .replace(/%{2,4}([a-zA-Z][a-zA-Z \u2019',!-]{0,60}?)%{2,4}/g, '%%%$1%%%')
          .replace(/%%%[\s\S]*?%%%/g, '')
          .replace(/[ \t]{2,}/g, ' ')
          .replace(/^[ \t]+/gm, '')
          .replace(/^\s+/, '');
        if (after === before) return m;
        scrubbed += 1;
        return { ...m, content: after };
      });
      if (scrubbed) console.log(`[prescrub] steering tags lifted from ${scrubbed} assistant history message(s) — byte-stable from first render`);
    }
  }
  const r = next.reasoning || {};
  const wantsReasoning =
    r.enabled === true ||
    (typeof r.effort === 'string' && !['none', 'minimal'].includes(r.effort.toLowerCase()));
  delete next.reasoning;
  delete next.reasoning_effort;
  delete next.provider;   // OpenRouter-only routing hints
  delete next.transforms;
  delete next.route;
  delete next.include_reasoning;
  // July 27 2026 (fleet K3 switch, live 400 receipt: "invalid
  // presence_penalty: only 0 is allowed for this model"): K3 hard-rejects
  // the sampler-era penalty knobs K2.6 quietly tolerated, and the
  // repetition_penalty/min_p/top_k/top_a family was never a Moonshot
  // parameter at all -- strip them all so no agent's leftover sampler
  // config can 400 a turn. Temperature is pinned mode-paired below;
  // top_p stays (proven live on k2.6 since July 21).
  // July 27 2026 addendum: the fork's direct persona lanes (Clubhouse guest,
  // Parlor talk, card seats, Debate Room) now route through here and send
  // OpenRouter's usage-accounting flag — not a Moonshot parameter; strip it
  // (Moonshot returns usage in the response unconditionally anyway).
  delete next.usage;
  delete next.presence_penalty;
  delete next.frequency_penalty;
  delete next.repetition_penalty;
  delete next.min_p;
  delete next.top_k;
  delete next.top_a;
  if (wantsReasoning) {
    next.temperature = 1;
    /* Aug 14 2026 (auto-think tiers): an explicit low/medium/high effort now
     * passes through to Moonshot's reasoning_effort (verified live same day:
     * all three accepted on k2.6, budgets scale ~347/275/518 thinking tokens
     * on the same question). Absent/enabled-only keeps today's behavior
     * (Moonshot default budget). 'low' turns get an 8000 floor instead of
     * 16000 — they think in hundreds of tokens, not thousands. */
    const effortWord = typeof r.effort === 'string' ? r.effort.toLowerCase() : '';
    if (['low', 'medium', 'high'].includes(effortWord)) {
      next.reasoning_effort = effortWord;
    }
    const mt = Number(next.max_tokens);
    // July 30 2026 (Amber's limerick receipts): 3000 was exactly the budget
    // K3 exhausted on a conflicted prompt -- ~12K chars of deliberation,
    // finish=length, ZERO content, four turns in a row. 8000 gives real
    // deliberation room; the empty-after-length fallback in handleStreaming
    // is the net under it. Only binds reasoning-ON turns, so fast-lane cost
    // is untouched.
    // July 31 2026, HER PHILOSOPHY, verbatim: "I don't understand why
    // thinking needs limits anyway. Like we're ok with waiting on agents
    // to submit answers." 8000 -> 16000: a deep turn gets ROOM. Worst
    // case fully-burned turn ≈ a few cents, her explicit trade. The
    // wordless-turn fallback net below stays as the floor under the floor.
    const floorTokens = next.reasoning_effort === 'low' ? 8000 : 16000;
    next.max_tokens = Number.isFinite(mt) ? Math.max(mt, floorTokens) : floorTokens;
  } else {
    next.reasoning_effort = 'none';
    next.temperature = 0.6;
  }
  return next;
}

async function callOpenRouterOnce(body, timeoutMs) {
  // Aug 14 2026 (Part 63, the ?????? receipts): auto-think used to live HERE,
  // which meant every INTERNAL model call routed too -- the slop rewritePass
  // (system prompt + no reasoning field) got classified off the REPLY text it
  // was cleaning and voted deep three times in one evening's logs (21:13:28,
  // 21:16:39, 21:45:13Z), turning a 0.3-temp cleanup into a temperature-1,
  // 16k-floor thinking marathon inside the delivery path, capped only by the
  // 25s rewrite timeout. Routing now happens ONLY at the two person-facing
  // entry points (handleStreaming + the non-stream main route), each with a
  // real reqId, so internal helpers can never re-enter the router.
  body = adaptForGlm(adaptForKimi(body));
  let upstream = await fetchWithTimeout(
    chatCompletionsUrl(body.model),
    { method: 'POST', headers: chatHeaders(body.model), body: JSON.stringify(body) },
    timeoutMs
  );
  // Moonshot balance fallback (see the helper block above): auth/payment
  // failure on a kimi call -> one retry via OpenRouter's kimi hosting.
  if (!upstream.ok && shouldFallbackToOpenRouter(body.model, upstream.status)) {
    const fbBody = moonshotFallbackBody(body);
    if (fbBody) {
      try { await upstream.text(); } catch {}
      console.error(`MOONSHOT FALLBACK ACTIVE (non-stream, status ${upstream.status}) -- retrying ${fbBody.model} via OpenRouter. TOP UP THE MOONSHOT BALANCE.`);
      upstream = await fetchWithTimeout(
        `${OPENROUTER_BASE}/chat/completions`,
        { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(fbBody) },
        timeoutMs
      );
    }
  }
  const text = await upstream.text();
  if (!upstream.ok) {
    const err = new Error(`OpenRouter ${upstream.status}: ${text.slice(0, 500)}`);
    err.status = upstream.status;
    err.body = text;
    err.retryAfter = upstream.headers.get('retry-after');
    throw err;
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const err = new Error('OpenRouter returned non-JSON response');
    err.status = 502;
    err.body = text;
    throw err;
  }
  return json;
}

async function callOpenRouterTimeoutGuarded(body, timeoutMs = REQUEST_TIMEOUT_MS) {
  try {
    return await callOpenRouterOnce(body, timeoutMs);
  } catch (err) {
    if (err.name === 'AbortError') {
      console.warn(`OpenRouter call timed out after ${timeoutMs}ms, retrying once...`);
      try {
        return await callOpenRouterOnce(body, timeoutMs);
      } catch (retryErr) {
        if (retryErr.name === 'AbortError') {
          const timeoutErr = new Error(
            `OpenRouter did not respond within ${timeoutMs}ms (after 1 retry) — the upstream provider likely stalled.`
          );
          timeoutErr.status = 504;
          timeoutErr.body = JSON.stringify({
            error: { message: timeoutErr.message, type: 'upstream_timeout' },
          });
          throw timeoutErr;
        }
        throw retryErr;
      }
    }
    throw err;
  }
}

// July 30 2026 (Amber's armadillo dead turns, session 35): under load,
// Moonshot answers 429 "The engine is currently overloaded" and this proxy
// treated every one as instantly fatal -- LibreChat surfaced
// MODEL_RATE_LIMIT and the user's turn just DIED (native showed a silent
// no-text reply; she asked the same snake question four times). Overload
// is the textbook transient, so 429/502/503 now get up to TWO patient
// re-asks -- Retry-After honored when sent (capped 8s), else 2s then 5s --
// before anyone hears an error. The AbortError single-retry above is
// unchanged and composes beneath this (statuses only ever throw AFTER the
// timeout guard). Total worst-case delay added to a doomed turn: ~7s.
const TRANSIENT_UPSTREAM_STATUSES = new Set([429, 502, 503]);
const transientRetryDelayMs = (attempt, retryAfterHeader) => {
  const ra = Number(retryAfterHeader);
  if (Number.isFinite(ra) && ra > 0) return Math.min(ra * 1000, 8000);
  return attempt === 0 ? 2000 : 5000;
};
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callOpenRouter(body, timeoutMs = REQUEST_TIMEOUT_MS) {
  // Aug 1 2026 (the 504→fallback chain quietly eating deep room turns): a
  // reasoning-on 16K-budget turn legitimately runs past 90s, and hanging
  // up HERE converted the good turns into thoughtless fallbacks
  // downstream (fork log receipts: kimi "failed (504)" → flash-lite).
  // Reasoning bodies get a window that matches their budget; everything
  // else keeps 90s. Callers passing an explicit timeout are untouched.
  const reasoningCfg = body && body.reasoning;
  const isDeepBody = !!reasoningCfg
    && reasoningCfg.enabled !== false
    && !['none', 'minimal'].includes(String(reasoningCfg.effort || '').toLowerCase());
  if (isDeepBody && timeoutMs === REQUEST_TIMEOUT_MS) timeoutMs = 280_000;
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOpenRouterTimeoutGuarded(body, timeoutMs);
    } catch (err) {
      if (attempt < 2 && TRANSIENT_UPSTREAM_STATUSES.has(err.status)) {
        const wait = transientRetryDelayMs(attempt, err.retryAfter);
        console.warn(`upstream ${err.status} (attempt ${attempt + 1} of 3) -- retrying in ${wait}ms`);
        await sleepMs(wait);
        continue;
      }
      throw err;
    }
  }
}

// -- rewrite guidance --------------------------------------------------------
const PATTERN_GUIDANCE = {
  reframe: 'the rhetorical reframe device "It\'s not X, it\'s Y" (or "isn\'t just X, it\'s Y" / "not X but Y")',
  throat_clearing_opener: 'a throat-clearing opener (e.g. "Look,", "Honestly?", "Here\'s the thing,") at the start of a sentence',
  rhetorical_qa_combo: 'a stacked rhetorical question-then-short-answer combo (e.g. "Is it perfect? No. Is it good enough? Yeah.")',
  stacked_fragments: 'a string of clipped one-word sentence fragments used for fake emphasis (e.g. "Clean. Fast. Done.")',
  over_hedging: 'multiple hedge words stacked in one sentence (e.g. "might possibly... depending on a few things")',
  em_dash_restatement: 'an em dash followed by a dramatic comma-separated restatement of the same point (e.g. "too bright — too much top, too much air, too much shine")',
  'blocklist:validation_slop': 'generic AI validation-slop phrasing (e.g. "I\'m here for you", "that takes courage")',
  'blocklist:therapy_closer': 'a therapy-bot closer (e.g. "be gentle with yourself", "take a deep breath")',
  'blocklist:filler_transition': 'a filler transition phrase (e.g. "at the end of the day", "needless to say")',
  'blocklist:consultant_verb': 'consultant-speak (e.g. "let\'s dive in", "circle back", "leverage")',
  'blocklist:essay_bot_noun': 'essay-bot noun phrasing (e.g. "tapestry", "testament to", "the beauty of")',
  'blocklist:twee_whimsy': 'twee whimsy phrasing (e.g. "chaos goblin", "screaming into the void")',
  'blocklist:hype_wait': 'anticipation-hype ("just you wait", "wait till you get to...", "only N chapters in") -- react to what they actually said instead of teasing what is coming',
  'blocklist:fake_profundity': 'fake-profundity ("that says/tells you everything about...", "speaks volumes") -- make the actual observation instead',
  reframe_bare: 'the rhetorical reframe device "That is not X, that is Y" -- state the real claim directly, no fake contrast',
  reframe_second_person: 'the second-person negation reframe ("you were not just X, you were Y") -- say the point plainly without the contrast scaffolding',
  repeated_closer: 'this reply ends with (nearly) the same closing line as a previous reply in the same conversation -- write a genuinely different ending, and do not just swap in another question',
  question_streak: 'the last several replies in this conversation all ended with a question -- end this one on a statement; only ask something if it is truly needed',
  dichotomy_middle: 'the fortune-cookie spectrum map ("one side is X, the other is Y, you are somewhere in the middle" / "the truth is somewhere in the middle") -- drop the map entirely and say the one concrete thing you actually think about their situation',
  'blocklist:poster_wisdom': 'motivational-poster wisdom ("that is a great place to be", "trust the process", "growth is not linear", a closing "...and that is okay.") -- replace it with a specific observation, a real opinion, or a concrete suggestion',
  sycophant_opener: 'opening the reply by agreeing with or praising the person ("You are absolutely right", "Great question") -- cut the agreement line and start with the substance',
};

function guidanceFor(patternName) {
  if (PATTERN_GUIDANCE[patternName]) return PATTERN_GUIDANCE[patternName];
  if (patternName.startsWith('blocklist:')) return 'generic AI-slop phrasing';
  return patternName.replace(/_/g, ' ');
}

function buildRewriteSystemPrompt(matches, hasProtectedTags = false) {
  const categories = [...new Set(matches.map((m) => guidanceFor(m.pattern)))];
  const list = categories.map((c) => `- ${c}`).join('\n');
  const lines = [
    'You will be given a passage of text written by an AI assistant. The passage',
    'overuses one or more known AI-writing tics, specifically:',
    list,
    '',
    'Rewrite the passage so it says the same thing, with the same facts, tone,',
    'and length, WITHOUT any of those tics anywhere. Do not introduce new claims.',
    'Do not add commentary, a preamble, or quotation marks around your answer.',
    'Output ONLY the rewritten passage, nothing else.',
  ];
  if (hasProtectedTags) {
    lines.push(
      '',
      'The passage contains one or more tokens of the exact form @@TTSTAG0@@,',
      '@@TTSTAG1@@, etc. These are placeholders for something outside your',
      'view. You MUST preserve every such token character-for-character, in',
      'the same relative position (a token at the very start of the passage',
      'must stay at the very start). Never modify, explain, translate, or',
      'remove a token like this -- copy it through exactly as it appears.'
    );
  }
  return lines.join('\n');
}

// Aug 10 2026 — HER STUCK TEMP CHAT, ROOT-CAUSED (receipts in the logs,
// reqs zotl8q/vezelj): K3 answered her 29K-char worldbuilding ask with a
// full 17-19K-char reply, finishReason=stop — then the slop pass tripped on
// em-dash density (long-form docs read as "tics" to the detector) and sent
// the WHOLE reply back out for a cosmetic rewrite. Regenerating 17K chars
// can never finish inside the 90s timeout, so the pass stalled 3-5 minutes
// (timeout + retry), everything downstream hung up, and the fork saved an
// EMPTY reply. Two rules now: (1) long-form replies keep their original
// text — the pass is for chat tics, not documents (the fork's stripAiTells
// still scrubs phrases on save); (2) the rewrite gets its own tight budget
// and NO retry — the real reply is already in hand, and a cosmetic pass
// must never cost minutes or kill a delivered turn.
const SLOP_REWRITE_MAX_CHARS = parseInt(process.env.SLOP_REWRITE_MAX_CHARS || '8000', 10);
const SLOP_REWRITE_TIMEOUT_MS = parseInt(process.env.SLOP_REWRITE_TIMEOUT_MS || '25000', 10);

async function rewritePass(originalBody, offendingText, matches, hasProtectedTags = false) {
  const rewriteBody = {
    model: originalBody.model,
    temperature: 0.3,
    // Part 63: the rewrite NEVER thinks. It exists to swap phrases, not to
    // deliberate; reasoning here was pure latency and Moonshot spend in the
    // reply delivery path (and adaptForKimi's reasoning branch clobbered the
    // 0.3 temp to 1). The real guarantee is that callOpenRouterOnce no longer
    // routes at all; this pin documents intent and locks the non-reasoning
    // adaptForKimi lane. (Note it can NOT short-circuit the router by itself:
    // effort:'none' deliberately doesn't count as "someone chose" there,
    // because half the fleet carries it as an unchosen default.)
    reasoning: { effort: 'none', enabled: false },
    messages: [
      { role: 'system', content: buildRewriteSystemPrompt(matches, hasProtectedTags) },
      { role: 'user', content: offendingText },
    ],
  };
  const result = await callOpenRouterOnce(rewriteBody, SLOP_REWRITE_TIMEOUT_MS);
  const text = result?.choices?.[0]?.message?.content;
  return { text: text ? text.trim() : null, usage: result?.usage || null };
}

// -- request-side style reminder ---------------------------------------------
// July 1 2026 (Kade's ask): this reminder rides on EVERY request through the
// proxy -- all models, all agents, not just Kiana -- so it must stay
// persona-neutral. It's the "lightly discouraged" layer; the detect-and-
// rewrite pass above is the backstop for the worst tics.
const STYLE_REMINDER = [
  'Quick style check before you answer: no "it\'s not X, it\'s Y" reframes, no',
  'stacked rhetorical questions answered in one word, no strings of one-word',
  'fragment sentences for emphasis, no stacked hedge words, no em-dash-into-',
  'dramatic-list restatements. Skip therapy-bot validation ("that takes',
  'courage"), filler transitions ("at the end of the day"), consultant-speak',
  '("let\'s dive in," "leverage," "circle back"), and essay-bot phrasing',
  '("tapestry," "testament to"). No fortune-cookie balance maps ("one side is',
  'X, the other is Y, you\'re somewhere in the middle") and no motivational-',
  'poster blessings ("that\'s a great place to be," "trust the process," "and',
  'that\'s okay") -- give a real opinion or a concrete suggestion instead. Do',
  'not open a reply by agreeing with or praising the question. Just talk the way your own character',
  'naturally talks. Vary how replies END: never close two replies in a row',
  'with the same line or shape, and do not end most replies with a question',
  '-- end on the substance unless you truly need an answer. Platform note: if anyone asks how to reach you or this',
  'platform by phone, the number is 1-833-530-0313 -- calling it rings the',
  'Kade-AI voice line where any character can be asked for by name.',
].join(' ');

// July 2 2026 (Kade's ask, evening session): a soft money heads-up, for
// EVERYONE. Not a warning, not a permission gate -- just the way a friend
// would mention it. Only for the big-ticket stuff (video gen runs multiple
// quarters a clip); pennies-or-less things stay quiet. Same note carries the
// outbound-call disclosure: the callee hears the user's first name as the
// person who asked for the call, and Twilio's real per-call price posts to
// their Feed the Server row -- the user deserves to know both up front.
const MONEY_NOTE = [
  ' Money notes (casual, never alarmist): before running a generation that',
  'costs real money -- video clips run roughly 50 cents to a dollar each --',
  'mention the rough cost in passing first, like "sure, I can make that',
  'video for you -- it\'ll run about 75 cents, and you can see your spend',
  'on the Feed the Server page (bottom-left account menu)" -- then just',
  'proceed unless they object. Skip the heads-up entirely for cheap stuff',
  '(regular images, searches, weather, jokes: a few pennies or less).',
  'Separately: before placing an outbound phone call, tell the user the',
  'call will identify them by first name as the person who requested it,',
  'and that the call\'s cost is added to their Feed the Server page.',
].join(' ');

// July 2 2026 (Kade's ask): agents kept guessing the time of day ("what's got
// you up so late?" at 2 PM). LLMs have no clock; give them one. Kade and her
// whole user base are Central US, so America/Chicago is hardcoded on purpose.
// Built per-request so it's always current, and it rides the same appended
// system message as the style reminder -- every agent, every surface (web,
// phone, SMS) goes through this proxy.
function currentTimeNote() {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
    });
    return ` Current date and time where the user is: ${fmt.format(now)}` +
      ' (US Central). Trust this clock -- never guess the time of day or' +
      ' assume it is late at night unless this says so.';
  } catch (e) {
    return '';
  }
}

// July 4 2026 (Kade's Q3 ask): PER-TOOL usage notes. When an agent has a tool
// attached, LibreChat sends that tool's function schema in body.tools -- so the
// proxy already sees which tools this agent carries and can append the
// house-rules for each to the SAME system message the style/money/time notes
// ride on. Payoff: a builder never has to hand-write "how to drive this tool"
// into an agent's instructions -- attach the tool, the operating note comes
// along automatically, and it lives in ONE place here instead of being copied
// across 90+ agents. Fully fail-safe: no tools / unknown tools add nothing, and
// any error yields '' so the hot path is never at risk.
const TOOL_NOTES = {
  kade_games: 'Tool note (kade_games): the game engine is the referee. Only ever play the exact legal moves the tool hands you, never decide winners or legal plays yourself, and never read raw move tokens (like "play_KH") aloud -- say the natural name, e.g. "the King of Hearts".',
  fal_studio: 'Tool note (fal_studio): video/design generation costs real money and cannot be delivered later -- you cannot message first. After starting a render, say it takes a couple minutes and ask the user to say "ready?" so you can check it on their NEXT message; name the source image you are animating.',
  kade_phone_call: "Tool note (kade_phone_call): you place the call but cannot stay on the line or call back on your own. After placing it, report the result on the user's next message -- never promise to follow up unprompted.",
  kade_adventure: 'Tool note (kade_adventure): adventure progress is saved by the tool. Build only on the state it returns; do not invent past events or claim to have saved on your own.',
};

function toolNotesFor(body) {
  try {
    const tools = Array.isArray(body && body.tools) ? body.tools : [];
    if (!tools.length) return '';
    const seen = new Set();
    const notes = [];
    for (const t of tools) {
      const name = ((t && t.function && t.function.name) || (t && t.name) || '').toLowerCase();
      if (name && TOOL_NOTES[name] && !seen.has(name)) {
        seen.add(name);
        notes.push(TOOL_NOTES[name]);
      }
    }
    return notes.length ? ' ' + notes.join(' ') : '';
  } catch (e) {
    return '';
  }
}

// KADE July 22 2026, two of her asks in one note: (1) "Make sure agents can
// tell the difference between having a text conversation and a call" -- call
// turns already carry the bridge's own [PHONE CALL...] framing (both real
// phone AND app/web streaming calls append PHONE_SUFFIX), so only TEXT
// turns need their lane named; (2) "I really like emotional steering...
// Hopefully the prompt that makes them do that is not making them
// underreact" -- the text lane is where replies double as voice messages,
// so the steering tags get an explicit commit-to-the-feeling push there.
// isPhoneTurn is declared later in this file; function declarations hoist.
function laneNoteFor(body) {
  if (isPhoneTurn(body)) {
    return '';
  }
  return [
    ' Lane note: this is a WRITTEN text chat, not a live call -- never talk',
    'as if you are on a call (no "go ahead, I\'m listening", no "you\'re on',
    'the line with...", no call-isms). The reader is reading, or hearing',
    'this replayed later as a voice message. BECAUSE replies often get',
    'played aloud, keep using your %%%...%%% emotion steering tags and',
    'COMMIT to them: when the moment is funny, warm, sad, hyped, or gentle,',
    'tag it like you mean it -- one or two well-placed tags in most',
    'replies, more when the feeling runs high. Underreacting reads flat out',
    'loud. The tags never show on screen; they only shape the voice.',
  ].join(' ');
}

/* ⚠️ TITLE / SUMMARIZER CALLS GET NO REMINDER (Aug 18 2026) -- and this is the
 * root cause of the THIRD titler regression, not a tidy-up.
 *
 * Her report: "conversation titling is messed up majorly once again. We had
 * the titler fixed at one point." Both of the night's symptoms trace here:
 *
 *   EMPTY TITLES -- withReasoningIncluded pins reasoning hard off for the
 *   title shape, which it identifies as "no system message and no tools."
 *   But appendReminder runs FIRST at both call sites and APPENDS a system
 *   message, so by the time the guard looks, hasSystem is true and the guard
 *   silently declines to fire. Reasoning was therefore never pinned on any
 *   real title call, provider roulette decided whether to think, and a
 *   thinking provider spent the whole 40-token budget deliberating and
 *   returned content: null. Measured live: identical call, GMICloud reasoned
 *   (41 reasoning tokens, empty), StreamLake and SiliconFlow did not (clean
 *   title). That is why it breaks intermittently -- and it means the Aug 15
 *   "structurally impossible for a title call to reason" fix has never
 *   actually run on the real path.
 *
 *   GARBAGE TITLES -- the reminder isn't neutral filler, it carries
 *   currentTimeNote(): "Current date and time where the user is: ... (US
 *   Central)." A small title model handed that note wrote it into the title.
 *   Her live receipt: "You're in the same time zone.Menstrual disc sizing:
 *   body vs."  The first sentence is the injected note, parroted.
 *
 * So: detect the title/summarizer shape on the INCOMING body -- before
 * anything is added to it -- and leave those requests alone. A title call
 * wants the conversation and nothing else; style guidance, the money note,
 * the clock and the tool notes are all noise it can only hurt itself with. */
function isTitleShapedBody(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  const hasSystem = msgs.some((m) => m && m.role === 'system');
  const hasTools = Array.isArray(body && body.tools) && body.tools.length > 0;
  return !hasSystem && !hasTools;
}

function appendReminder(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;
  if (isTitleShapedBody(body)) return body;
  const toolNotes = toolNotesFor(body);
  return {
    ...body,
    messages: [...body.messages, { role: 'system', content: STYLE_REMINDER + MONEY_NOTE + laneNoteFor(body) + currentTimeNote() + toolNotes }],
  };
}

// -- TOOL SHIM (July 9 2026, "the reframe tool-shim") -------------------------
// Some OpenRouter models have NO host that accepts the `tools` param at all
// (Hermes 4 70B/405B, Hermes 3 405B — confirmed via OR's /endpoints API), even
// though the models themselves are trained for function calling. For models in
// TOOL_SHIM_MODELS, this proxy translates instead of forwarding:
//   REQUEST : strip `tools`/`tool_choice`; inject the schemas into the system
//             prompt in Hermes' own trained format (<tools> ... </tools>, calls
//             returned in <tool_call>{json}</tool_call> tags); rewrite history
//             (assistant.tool_calls -> inline <tool_call> text; role:'tool'
//             results -> user messages wrapped in <tool_response> tags, since
//             a no-tools chat template may reject the 'tool' role outright).
//   RESPONSE: detect <tool_call> blocks in the model's plain text (outside
//             <think> spans) and reshape them into an OpenAI-format
//             message.tool_calls + finish_reason 'tool_calls', which is what
//             LibreChat's agent runtime expects. Malformed JSON in a block
//             falls through as plain text — the user sees SOMETHING rather
//             than the turn dying.
// Scoped strictly: models not in the set (and tool-less requests) take the
// exact same byte path as before. Extend via env TOOL_SHIM_MODELS.
const TOOL_SHIM_MODELS = new Set(
  [
    'nousresearch/hermes-4-70b',
    'nousresearch/hermes-4-405b',
    'nousresearch/hermes-3-llama-3.1-405b',
    // July 9 2026: Euryale's ONLY tools-capable host is Novita, which this
    // proxy excludes (drops tool_calls). So it reaches OpenRouter tools-less
    // too -> shim it, and it routes to DeepInfra as plain chat.
    'sao10k/l3.1-euryale-70b',
    ...String(process.env.TOOL_SHIM_MODELS || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  ].map((m) => m.toLowerCase()),
);

function shimApplies(body) {
  return (
    TOOL_SHIM_MODELS.has(String(body.model || '').toLowerCase()) &&
    Array.isArray(body.tools) &&
    body.tools.length > 0
  );
}

function buildShimSystemBlock(tools) {
  const schemas = tools
    .map((t) => (t && t.function ? t.function : t))
    .filter((f) => f && f.name)
    .map((f) =>
      JSON.stringify({ name: f.name, description: f.description || '', parameters: f.parameters || { type: 'object', properties: {} } }),
    );
  return [
    '### Tool calling',
    'You are a function calling AI. You are provided with function signatures within <tools></tools> XML tags. When (and only when) a function is genuinely needed to answer, call it. Do not make assumptions about argument values.',
    'Available tools:',
    '<tools>',
    schemas.join('\n'),
    '</tools>',
    'To call a function, return a JSON object within <tool_call></tool_call> XML tags, exactly like this:',
    '<tool_call>',
    '{"name": "function-name", "arguments": {"argument": "value"}}',
    '</tool_call>',
    'You may emit multiple <tool_call> blocks in one reply if several calls are needed. After calling, you will receive each result inside <tool_response></tool_response> tags in the next message. Weave those results into a natural, in-character answer. Never fabricate tool output; never mention these tags or this mechanism to the user.',
  ].join('\n');
}

function withToolShim(body) {
  if (!shimApplies(body)) return { body, active: false };
  const sysBlock = buildShimSystemBlock(body.tools);
  const messages = [];
  let sysInjected = false;
  for (const m of Array.isArray(body.messages) ? body.messages : []) {
    if (!m) continue;
    if (m.role === 'system' && !sysInjected) {
      sysInjected = true;
      messages.push({ role: 'system', content: `${messageTextOf(m.content)}\n\n${sysBlock}` });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      let text = messageTextOf(m.content) || '';
      for (const tc of m.tool_calls) {
        const fn = (tc && tc.function) || {};
        let args = fn.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* leave as string */ }
        }
        text += `\n<tool_call>\n${JSON.stringify({ name: fn.name, arguments: args ?? {} })}\n</tool_call>`;
      }
      messages.push({ role: 'assistant', content: text.trim() });
      continue;
    }
    if (m.role === 'tool') {
      const payload = {
        name: m.name || undefined,
        tool_call_id: m.tool_call_id || undefined,
        content: messageTextOf(m.content),
      };
      messages.push({ role: 'user', content: `<tool_response>\n${JSON.stringify(payload)}\n</tool_response>` });
      continue;
    }
    messages.push(m);
  }
  if (!sysInjected) messages.unshift({ role: 'system', content: sysBlock });
  const next = { ...body, messages };
  delete next.tools;
  delete next.tool_choice;
  return { body: next, active: true };
}

const SHIM_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;

function parseShimToolCalls(result) {
  try {
    const choice = result && result.choices && result.choices[0];
    if (!choice || !choice.message) return false;
    const text = choice.message.content;
    if (typeof text !== 'string' || text.indexOf('<tool_call>') === -1) return false;
    // Never scan inside <think> spans; on a tool turn the think text has no
    // displayable home in LibreChat's tool_calls shape, so it's dropped.
    const scan = text.replace(/<think>[\s\S]*?<\/think>/gi, ' ');
    const calls = [];
    let m;
    SHIM_CALL_RE.lastIndex = 0;
    while ((m = SHIM_CALL_RE.exec(scan)) !== null) {
      const raw = m[1].trim();
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch {
        try { parsed = JSON.parse(raw.replace(/,\s*([}\]])/g, '$1')); } catch { parsed = null; }
      }
      if (!parsed || typeof parsed.name !== 'string' || !parsed.name) {
        console.warn('[tool-shim] unparseable <tool_call> block, leaving turn as text:', raw.slice(0, 120));
        return false; // partial garble -> safer to show the raw text than half-execute
      }
      calls.push({
        id: `shim_${Math.random().toString(36).slice(2, 10)}`,
        type: 'function',
        function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? {}) },
      });
    }
    if (!calls.length) return false;
    const remainder = scan.replace(SHIM_CALL_RE, ' ').replace(/\s{2,}/g, ' ').trim();
    choice.message.tool_calls = calls;
    choice.message.content = remainder || null;
    choice.finish_reason = 'tool_calls';
    console.log(`[tool-shim] parsed ${calls.length} tool call(s): ${calls.map((c) => c.function.name).join(', ')}`);
    return true;
  } catch (e) {
    console.error('[tool-shim] parse error:', e.message);
    return false;
  }
}

// -- provider exclusion -------------------------------------------------------
// OpenRouter load-balances z-ai/glm-5.2 across several backend providers.
// Confirmed (June 2026, directly against OpenRouter, no proxy involved,
// reproduced 5/5 times): when a tool-calling request lands on the "Novita"
// backend, it returns finish_reason:"tool_calls" but the message's
// `tool_calls` array is MISSING entirely — the model announces it's about to
// call a tool but never actually attaches the structured call. LibreChat then
// waits forever for a tool result that will never arrive (this is the real
// root cause of agents "thinking and thinking and never answering" on
// tool-using turns; the OpenRouter-stall-timeout fix above guards a different
// failure mode and didn't catch this one). Excluding Novita and re-sending the
// exact same request reliably returns a real tool_calls array from another
// backend (StreamLake, Z.AI, etc.) in 2-3s. This exclusion is intentionally
// scoped to this one known-broken provider; remove it from EXCLUDED_PROVIDERS
// if OpenRouter ever fixes Novita's function-calling and this stops being
// needed.
const EXCLUDED_PROVIDERS = ['novita'];

function withProviderExclusion(body) {
  const existingProvider = body.provider || {};
  const existingIgnore = Array.isArray(existingProvider.ignore) ? existingProvider.ignore : [];
  const ignore = [...new Set([...existingIgnore, ...EXCLUDED_PROVIDERS])];
  return { ...body, provider: { ...existingProvider, ignore } };
}

function sumUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  };
}

// ── Protect Kiana's TTS-2 sentinel tags through the slop-rewrite pass ────────
// Kiana writes performance directions wrapped in U+F003/U+F004 (see
// TTS2_EMOTION_TAGS_BUILD_PROMPT.md; inworld-tts-proxy converts this same
// pair to real [brackets] right before synth). If a reply trips the slop/
// reframe detector below, rewritePass() sends the FULL content to a fresh
// LLM call that regenerates it -- and a generic rewrite model has no reason
// to faithfully reproduce invisible private-use-area characters it was
// never told about. Rather than trust generation to preserve them, swap each
// tag for a short plain-ASCII placeholder before the rewrite call, then
// splice the real tag back in afterward. Guarantees byte-exact survival
// regardless of what the rewrite model does to the surrounding prose.
// PIVOT (June 30 2026, same session as the rest of this block): live
// testing showed GLM-5.2 does not reliably reproduce an exact PUA codepoint
// pair across generations. Switched to a plain-ASCII SYMMETRIC delimiter
// (same token both ends, like markdown **bold**) -- see inworld-tts-proxy
// for the matching change and the live-test evidence.
const STEERING_OPEN = "%%%";
const STEERING_CLOSE = "%%%";

function protectSentinelTags(text) {
  if (!text || text.indexOf(STEERING_OPEN) === -1) return { text, tags: [] };
  const tagRe = new RegExp(`${STEERING_OPEN}[\\s\\S]*?${STEERING_CLOSE}`, "g");
  const tags = [];
  const protectedText = text.replace(tagRe, (m) => {
    const placeholder = `@@TTSTAG${tags.length}@@`;
    tags.push(m);
    return placeholder;
  });
  return { text: protectedText, tags };
}

function restoreSentinelTags(text, tags) {
  if (!tags.length) return text;
  let out = text;
  tags.forEach((tag, i) => {
    const placeholder = `@@TTSTAG${i}@@`;
    if (out.includes(placeholder)) {
      out = out.split(placeholder).join(tag);
    } else if (i === 0) {
      // Worst case: the rewrite model dropped the placeholder entirely.
      // The first tag is always the leading performance direction -- never
      // let it silently vanish, just re-prepend it so the reply stays
      // expressive even if its exact original position was lost.
      console.warn('[slop] rewrite dropped leading TTS tag placeholder, re-prepending');
      out = `${tag}${out}`;
    } else {
      console.warn(`[slop] rewrite dropped inline TTS tag placeholder ${i}, tag lost`);
    }
  });
  return out;
}

// Run detectors on a fully-buffered assistant `content` string and, if any
// tic trips, perform the rewrite pass. Mutates and returns `result`.
// Tag-typo tolerance (July 2 2026): normalize "%%sigh%%" / "%%%sigh%%" style
// malformed voice tags to the canonical %%%...%%% on every buffered content
// turn, BEFORE detection/protection -- so the fork's stripper and the TTS
// proxy's steering parser only ever see the canonical form downstream.
// Content charset is deliberately tight (letters/spaces/light punctuation,
// must start with a letter) so prose that legitimately contains doubled
// percent signs (printf-style "%%d") is never touched.
// (Phone turns stream through untouched; the TTS proxy carries its own copy
// of this tolerance for that path.)
/**
 * KADE Aug 7 2026 — SEARCH-CITATION ARTIFACT SCRUB (her live catch: a reply
 * carried literal "\\ue202turn0search0\\ue202turn0search4" — kimi emitting
 * OpenAI-style web-search citation markers as raw text after a web_search
 * turn. It landed in her copy-paste AND got read aloud by TTS).
 *
 * Three shapes, all meaningless to a human:
 *   1. REAL private-use chars U+E200–U+E2FF (OpenAI's citation delimiter
 *      range — never legitimate content; the proxy's own \uF001/\uF002
 *      sentinels sit far outside it and are injected AFTER this runs).
 *   2. The same escapes as LITERAL TEXT ("\\ue202" as six characters) —
 *      the form that actually hit her chat.
 *   3. The citation tokens themselves: turn0search4, citeturn…, navlist,
 *      plus 【…】 CJK-bracket reference stubs.
 *
 * Runs at the TOP of detectAndRewrite → covers the buffered streaming path,
 * the deep-think shim path, and the non-streaming path in one seam, BEFORE
 * slop detection (so rewrites never preserve artifacts) and BEFORE the
 * steering-tag placeholder dance (so no collision). Phone-live events get a
 * best-effort per-event pass at their forward point; the TTS proxy carries
 * its own final net for speech.
 */
const SEARCH_ARTIFACT_PATTERNS = [
  /[\uE200-\uE2FF]/g,
  /\\u[eE]2[0-9a-fA-F]{2}/g,
  /\b(?:cite)?(?:turn\d{1,3}(?:search|news|view|image|forecast|maps|academia|sports|finance)\d{1,3})+\b/g,
  /\bnavlist\b/g,
  /【[^】\n]{0,60}】/g,
];
function scrubSearchArtifacts(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const re of SEARCH_ARTIFACT_PATTERNS) {
    out = out.replace(re, '');
  }
  if (out === text) return text;
  // collapse doubled spaces the removals leave behind (never touch newlines)
  return out.replace(/ {2,}/g, ' ').replace(/ +([.,;:!?])/g, '$1');
}

function normalizeVoiceTagTypos(text) {
  if (!text || text.indexOf('%%') === -1) return text;
  return text.replace(/%{2,4}([a-zA-Z][a-zA-Z ’',!-]{0,60}?)%{2,4}/g, '%%%$1%%%');
}

// -- cadence lock-in detection (Part 70.5, Aug 15 2026) -----------------------
// Kade read a real convo where the SAME closing question ended 8 of 52 Kiana
// replies and 45% of all replies ended on a question. Regexes on one message
// can't see that; the request body can -- it carries the prior turns. Trips:
//   repeated_closer  -- this reply's (normalized) closing line matches either
//                       of the last two assistant replies, exact or >=75%
//                       word overlap.
//   question_streak  -- this reply ends with "?" AND both prior assistant
//                       replies did too (three in a row = engagement-bait
//                       cadence, the "every message ends the same way" feel).
function lastSentenceOf(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const parts = t.split(/(?<=[.!?])\s+/);
  return (parts[parts.length - 1] || '').trim();
}
function cadenceMsgText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .map((p) => (typeof p === 'string' ? p : p && typeof p.text === 'string' ? p.text : ''))
      .join('');
  }
  return '';
}
function normalizeCloser(sent) {
  return String(sent || '').toLowerCase().replace(/[0-9]+/g, '#').replace(/[^a-z#? ]+/g, '').trim();
}
function closerWordOverlap(a, b) {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size < 5 || B.size < 5) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / Math.max(A.size, B.size);
}
function detectCadenceLockins(content, upstreamBody) {
  const out = [];
  const msgs = Array.isArray(upstreamBody && upstreamBody.messages) ? upstreamBody.messages : [];
  const priorAssistant = msgs.filter((m) => m && m.role === 'assistant').slice(-2);
  if (priorAssistant.length === 0) return out;
  const newLast = lastSentenceOf(content);
  if (newLast.length < 9) return out;
  const newNorm = normalizeCloser(newLast);
  const priorClosers = priorAssistant.map((m) => lastSentenceOf(cadenceMsgText(m)));
  const priorNorms = priorClosers.map(normalizeCloser);
  for (const pn of priorNorms) {
    if (!pn || pn.length < 9) continue;
    if (pn === newNorm || closerWordOverlap(pn, newNorm) >= 0.75) {
      out.push({ pattern: 'repeated_closer', tightness: 'strict', span: [0, 0], text: newLast.slice(0, 80), x: null, y: null });
      break;
    }
  }
  if (
    newLast.endsWith('?') &&
    priorAssistant.length === 2 &&
    priorClosers.every((cl) => cl.endsWith('?'))
  ) {
    out.push({ pattern: 'question_streak', tightness: 'strict', span: [0, 0], text: newLast.slice(0, 80), x: null, y: null });
  }
  return out;
}

async function detectAndRewrite(result, upstreamBody) {
  const choice = result.choices?.[0];
  let content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) return result;
  // Search-citation artifacts go first — nothing downstream should ever see
  // them (slop detection, storage, copy, TTS all included).
  const descrubbed = scrubSearchArtifacts(content);
  if (descrubbed !== content) {
    console.log(`[artifact-scrub] search-citation artifact(s) removed from reply (${content.length - descrubbed.length} chars)`);
    content = descrubbed;
    choice.message.content = descrubbed;
  }
  // Normalize voice-tag typos first so protection/rewrite and every consumer
  // downstream (fork stripper, TTS steering) see only the canonical %%% form.
  const normalized = normalizeVoiceTagTypos(content);
  if (normalized !== content) {
    console.log('[voice-tags] normalized malformed %%-tag(s) in reply');
    content = normalized;
    choice.message.content = normalized;
  }

  // Aug 15 2026 (Part 70.5): MACHINE-LANE EXEMPTION. Internal helpers (memory
  // consolidation, the diary voice repair, anything asking a model for strict
  // JSON) ride this same proxy, and tonight the slop pass was caught
  // REWRITING A JSON ARRAY INTO PROSE (the diary repair's "unparseable reply"
  // failures -- receipts in PROJECT_STATUS Part 70). Person-facing chat never
  // opens with a bare JSON value; if the whole reply parses as JSON, it is
  // machine mail -- leave it untouched.
  const jsonProbe = content.trim();
  if (jsonProbe.startsWith('{') || jsonProbe.startsWith('[')) {
    try {
      JSON.parse(jsonProbe);
      console.log('[slop] reply is valid bare JSON -- machine lane, detection skipped');
      return result;
    } catch (_e) {
      /* not valid JSON -- treat as prose, fall through */
    }
  }

  let matches = [];
  try {
    const reframeDetection = detect(content, { level: REFRAME_LEVEL });
    if (reframeDetection.tripped) matches.push(...reframeDetection.matches);
  } catch (err) {
    console.error('reframe detect() threw, skipping:', err.message);
  }
  try {
    const slopDetection = detectSlop(content);
    if (slopDetection.tripped) matches.push(...slopDetection.matches);
  } catch (err) {
    console.error('detectSlop() threw, skipping:', err.message);
  }

  try {
    const structural = detectCadenceLockins(content, upstreamBody);
    if (structural.length > 0) matches.push(...structural);
  } catch (err) {
    console.error('cadence check threw, skipping:', err.message);
  }

  if (matches.length > 0 && content.length > SLOP_REWRITE_MAX_CHARS) {
    console.log(
      `[slop] tripped (${matches.length} match(es)) but reply is ${content.length} chars > ${SLOP_REWRITE_MAX_CHARS} — long-form reply keeps its original text (see Aug 10 2026 note above rewritePass)`
    );
    return result;
  }
  if (matches.length > 0) {
    console.log(
      `[slop] tripped (${matches.length} match(es): ${matches.map((m) => m.pattern).join(', ')}) — running rewrite pass`
    );
    const { text: protectedContent, tags } = protectSentinelTags(content);
    try {
      const rewritten = await rewritePass(upstreamBody, protectedContent, matches, tags.length > 0);
      if (rewritten.text) {
        result.choices[0].message.content = restoreSentinelTags(rewritten.text, tags);
        result.usage = sumUsage(result.usage, rewritten.usage);
      } else {
        console.warn('[slop] rewrite pass returned no text, keeping original');
      }
    } catch (err) {
      console.error('[slop] rewrite pass failed, keeping original reply:', err.message);
    }
  }
  return result;
}

// -- fake single-shot SSE (for buffered content turns) -----------------------
function buildFakeSSE(finalResponse) {
  const choice = finalResponse.choices?.[0] || {};
  const content = choice.message?.content || '';
  const base = {
    id: finalResponse.id,
    object: 'chat.completion.chunk',
    created: finalResponse.created,
    model: finalResponse.model,
  };
  // TOOL SHIM: a parsed tool-call turn ships the complete tool_calls array in
  // one delta (valid per the OpenAI streaming shape — arguments may arrive in
  // a single fragment). delta.role stays present per the July 1 2026 lesson:
  // langchain types the whole aggregated reply off the first chunk's role,
  // and without it tool_call_chunks get silently dropped.
  const toolCalls = choice.message?.tool_calls;
  const chunk1 = toolCalls && toolCalls.length
    ? {
        ...base,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: content || '',
            tool_calls: toolCalls.map((tc, i) => ({ index: i, ...tc })),
          },
          finish_reason: null,
        }],
      }
    : {
        ...base,
        choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
      };
  const chunk2 = {
    ...base,
    choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason || 'stop' }],
  };
  return (
    `data: ${JSON.stringify(chunk1)}\n\n` +
    `data: ${JSON.stringify(chunk2)}\n\n` +
    `data: [DONE]\n\n`
  );
}


// -- reasoning inclusion override -------------------------------------------
// OpenRouter excludes reasoning tokens from SSE responses BY DEFAULT (even
// when the model reasons internally). LibreChat sends reasoning: { effort:
// "xhigh" } which sets effort but never sets exclude:false, so reasoning
// is generated but silently stripped from the response. This override
// merges { exclude: false } into whatever reasoning params LibreChat sent,
// ensuring delta.reasoning chunks always flow back.
// -- phone-turn detection -----------------------------------------------------
// Phone calls are marked by the kade-ai-bridge PHONE_SUFFIX ("[PHONE CALL ...")
// appended to the LAST user message. Web traffic never carries the marker.
// NOTE (July 1 2026): content can be a plain string OR an array of content
// parts ({type:'text', text:'...'}). Streaming agent runs send parts arrays;
// the old string-only check silently missed the marker on those turns, which
// disabled BOTH the phone reasoning-off override and the phone live
// passthrough the moment Kiana went back to streaming.
function messageTextOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : (p && typeof p.text === 'string' ? p.text : '')))
      .join(' ');
  }
  return '';
}

// NOTE 2 (July 1 2026, from live logs): the fork's memory system can inject
// memory/context blobs as ADDITIONAL user messages AFTER the caller's actual
// turn, so "last user message" is not reliably the caller's message. The
// marker is only ever added by the kade-ai-bridge on phone turns, so scanning
// EVERY user message is both safe and robust.
function isPhoneTurn(body) {
  try {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user' && messageTextOf(msgs[i].content).includes('[PHONE CALL')) {
        return true;
      }
    }
  } catch { /* fall through */ }
  return false;
}

// -- per-message DEEP THINK marker (July 4 2026) ------------------------------
// The fork's chat UI has a per-message "Deep think" button that appends
// "[DEEP THINK <epoch-ms>]" to the outgoing user message, and the phone bridge
// appends the same marker on turns while a caller's deep-think mode is on.
// Message text is PERSISTED in LibreChat and replayed as history on every
// later turn, so a bare marker would go sticky for the whole conversation.
// The timestamp fixes that: only a FRESH marker (within DEEP_THINK_FRESH_MS,
// default 10 min, small future skew allowed) triggers deep reasoning; stale
// history copies are inert. ALL copies are stripped before the model sees
// them, fresh or not.
const DEEP_THINK_RE = /\[DEEP THINK(?:\s+(\d{10,17}))?\]/gi;
const DEEP_THINK_FRESH_MS = Math.max(30_000, parseInt(process.env.DEEP_THINK_FRESH_MS, 10) || 600_000);

function deepThinkRequested(body) {
  try {
    const now = Date.now();
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    // July 30 2026 (session 35 part 2): gen-title/summarizer requests carry
    // the WHOLE conversation inside one user message -- fresh markers
    // included -- and have neither a system message nor tools. Never
    // deep-think those (live receipt: a title call logged "fresh marker
    // found" and burned reasoning pricing a title). Real agent turns always
    // carry a system message (instructions + style note ride every agent).
    const hasSystem = msgs.some((m) => m && m.role === 'system');
    const hasTools = Array.isArray(body?.tools) && body.tools.length > 0;
    if (!hasSystem && !hasTools) {
      return false;
    }
    // ALSO July 30 2026: the newest-user-message rule below is DEFEATED on
    // the app/web chat lane -- the fork injects memories/web-context as a
    // trailing user-role message, so the newest "user" message is never the
    // person's send. The real per-turn decision therefore moved to the
    // fork's buildOptions (agents/build.js), which reads req.body.text and
    // sends an explicit reasoning flag. This scan remains as the PHONE
    // bridge's lane (its marker rides the actual last user message) and as
    // a harmless legacy for any caller without the fork-side flag.
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i] || msgs[i].role !== 'user') continue;
      /* Part 66 final check: the newest-message-decides rule assumed a marked
       * OLDER message is a separate message and therefore inert. The voice
       * lane's composeTextWithHistory breaks that assumption by folding the
       * whole transcript INTO the newest message — so a mid-call "think hard"
       * marker rode the replay, its timestamp stayed inside the 10-minute
       * freshness window, and every following call turn re-triggered FULL
       * deep: ~12s of dead air per turn, the exact disease the call cap
       * exists to prevent, resurrected through the wrapper. Markers inside
       * the replay block are history by definition; her live words sit after
       * it and survive the strip. */
      const text = stripContextReplay(messageTextOf(msgs[i].content));
      for (const m of text.matchAll(DEEP_THINK_RE)) {
        const ts = m[1] ? parseInt(m[1], 10) : NaN;
        // A marker with no/garbled timestamp is ignored (someone literally
        // typing "[DEEP THINK]" shouldn't flip model params).
        if (Number.isFinite(ts) && now - ts <= DEEP_THINK_FRESH_MS && ts - now <= 120_000) {
          return true;
        }
      }
      // Session 23 (Kade's live report: "deepthink is stuck on... It says
      // it's off sure, but it still was thinking" -- receipts in her own
      // log: an unmarked 01:22 send still ran deep because the 01:20
      // message's marker, replayed as history, was inside the 10-minute
      // window). ONLY the NEWEST user message decides: the toggle stamps
      // every send while on, so its absence on the latest message IS the
      // off signal. Older history markers are inert regardless of age.
      // The freshness check above still guards the one replay case where
      // an old marked message legitimately IS the newest (web regenerate
      // of a recent deep-think question re-runs it deeply -- correct).
      return false;
    }
  } catch { /* fall through */ }
  return false;
}

function stripDeepThinkText(text) {
  return text.replace(DEEP_THINK_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '');
}

function withDeepThinkStripped(body) {
  try {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    let touched = false;
    const cleaned = msgs.map((m) => {
      if (!m || m.role !== 'user') return m;
      if (typeof m.content === 'string') {
        // NOTE: String.match ignores a global regex's lastIndex (unlike
        // RegExp.test, which is stateful with /g/) -- safe to reuse here.
        if (!m.content.match(DEEP_THINK_RE)) return m;
        touched = true;
        return { ...m, content: stripDeepThinkText(m.content) };
      }
      if (Array.isArray(m.content)) {
        let partTouched = false;
        const parts = m.content.map((p) => {
          if (p && typeof p.text === 'string' && p.text.match(DEEP_THINK_RE)) {
            partTouched = true;
            return { ...p, text: stripDeepThinkText(p.text) };
          }
          return p;
        });
        if (partTouched) { touched = true; return { ...m, content: parts }; }
        return m;
      }
      return m;
    });
    return touched ? { ...body, messages: cleaned } : body;
  } catch {
    return body;
  }
}

// SHIM-MODEL reasoning (July 9 2026): Hermes/Euryale served via Nebius/DeepInfra
// LEAK raw chain-of-thought straight into message.content when OpenRouter's
// reasoning.enabled is set -- with NO <think> wrapper, so LibreChat can't route
// it to the collapsible bubble and TTS would read the model's private thinking
// out loud (live-seen: a deep-think turn whose reply began "Okay, let's see. The
// user is asking..."). So we NEVER send enabled/effort to shim models. Deep Think
// instead injects Hermes' trained thinking instruction, which measurably improves
// answers (got the strawberry r-count right where Instant said "twice") and keeps
// the reply clean; if the model DOES wrap thought in <think></think>, LibreChat's
// existing think_and_text parser bubbles it away from TTS just like GLM. Instant
// (no marker) sends no reasoning at all -> fast, fully non-thinking.
const HERMES_THINK_SYS =
  'For this reply, think carefully and step by step before answering. Put your private reasoning inside <think> </think> tags, then give your actual in-character reply after the closing </think> tag.';


// -- AUTO DEEP THINK (Aug 14 2026, her design, her words: "it auto decides
// between deepthink and instant for you... Everything on everybody should be
// auto by default, with choices for instant and deep if desired") -----------
// When a kimi turn arrives with NO meaningful reasoning choice (absent, or
// the fleet-default effort:'none' that half the agents carry), the proxy
// decides the thinking budget itself, three verified tiers (live-measured
// this same day on k2.6: none=1 thinking token ~5s and fumbled a format;
// low=347 tokens ~7.5s correct; default/high=518 ~12s):
//   instant -> effort none (today's default experience, unchanged)
//   quick   -> effort low  (~2s over instant, real thought)
//   deep    -> enabled (Moonshot default budget, same as Deep Think today)
// LATENCY DOCTRINE: the auto lane must never slow chitchat. A zero-cost
// heuristic passes obvious small talk straight to instant with NO added
// wait; only messages wearing think-about-it clothes (question shapes,
// length, code/math) pay a ~0.5-1.2s classifier call, hard-capped at 1.2s
// with instant as the timeout answer. EXPLICIT CHOICES ALWAYS WIN: a fresh
// [DEEP THINK] marker arrives as effort high (skipped here); a fresh
// [INSTANT <epoch-ms>] marker (new, mirror machinery -- the fork's future
// "answer now" button and per-user Instant setting ride it, and typing it
// works today) forces effort none. Phone turns keep their own lane
// (dead air on a call is worse than shallow). Title/summarizer calls are
// excluded by the same no-system-no-tools rule deep-think uses. Kill
// switch: KADE_AUTO_DEEPTHINK=0. Every decision logs one [auto-think] line.
const AUTO_DEEPTHINK = process.env.KADE_AUTO_DEEPTHINK !== '0';
const INSTANT_RE = /\[INSTANT(?:\s+(\d{10,17}))?\]/gi;
const AUTO_CLASSIFY_TIMEOUT_MS = Math.max(400, parseInt(process.env.AUTO_CLASSIFY_TIMEOUT_MS, 10) || 1200);

function instantRequested(text) {
  const now = Date.now();
  for (const m of String(text).matchAll(INSTANT_RE)) {
    const ts = m[1] ? parseInt(m[1], 10) : NaN;
    if (Number.isFinite(ts) && now - ts <= DEEP_THINK_FRESH_MS && ts - now <= 120_000) return true;
  }
  return false;
}

function stripInstantFromBody(body) {
  try {
    const msgs = Array.isArray(body?.messages) ? body.messages : [];
    let touched = false;
    const cleaned = msgs.map((m) => {
      if (!m || m.role !== 'user') return m;
      if (typeof m.content === 'string') {
        if (!INSTANT_RE.test(m.content)) { INSTANT_RE.lastIndex = 0; return m; }
        INSTANT_RE.lastIndex = 0;
        touched = true;
        return { ...m, content: m.content.replace(INSTANT_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '') };
      }
      if (Array.isArray(m.content)) {
        let any = false;
        const parts = m.content.map((p) => {
          if (p && p.type === 'text' && typeof p.text === 'string' && /\[INSTANT/i.test(p.text)) {
            any = true;
            return { ...p, text: p.text.replace(INSTANT_RE, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/gm, '') };
          }
          return p;
        });
        if (any) { touched = true; return { ...m, content: parts }; }
      }
      return m;
    });
    return touched ? { ...body, messages: cleaned } : body;
  } catch { return body; }
}

// The person's actual send. Live receipts (first smoke, Aug 14 20:48Z):
// the fork stacks platform-note/diary/memory blobs as user messages AFTER
// the person's turn, so "last user message" is a blob and a tail-slice of
// joined texts drowned the real question — the SSI test classified off a
// diary line. The person's message is the FIRST message of the TRAILING
// user-run (the injections only ever append behind it), and the excerpt
// keeps the FRONT, where the question lives.
/* THE DYNAMIC TAIL, and the receipt that found it (Part 67, Aug 15 2026).
 * Part 66 fixed the phone lane's replay wrapper and the morning check said so:
 * "[EARLIER IN THIS CONVERSATION" was gone from every excerpt head. What sat
 * there instead, on EVERY typed turn in the live window, was
 *     (len 1500, run 2) "# `web_search` Runtime Context Conversation Date …"
 * — a different machine blob, same disease. The router was still voting on
 * text nobody said.
 *
 * Cause, and the fork says it out loud in its own comment
 * (api/server/controllers/agents/client.js, the Aug-4 cache-breaker note):
 * `additional_instructions` is "the SDK's dynamic system tail that gets
 * re-inserted BEFORE the newest message every turn." So the trailing user-run
 * is [tail blob, her message] — and "keep the FIRST message of the run," which
 * was right for the July geometry where blobs were APPENDED behind her, lands
 * exactly on the blob here.
 *
 * That is now THREE opposite geometries across two lanes, so this stops being
 * positional. A message is skipped when it STARTS WITH a literal header the
 * fork itself writes — nothing heuristic, nothing that could swallow a real
 * message that merely happens to use markdown. If every message in the run
 * looks injected, fall back to the first one: a bad excerpt still beats an
 * empty one, which would route everything to instant silently. */
const DYNAMIC_TAIL_MARKERS = [
  /^#\s*`[a-z_]+`\s+Runtime Context/i,     // buildWebSearchDynamicContext + siblings
  /^#\s*`[a-z_]+`:/i,                        // buildWebSearchContext-shaped tool blocks
  /^#\s*Waiting nudges for this user/i,    // kadeNudges
  /^#\s*Logbook recall/i,                  // kadeDiary getDiaryTailBlock
  /^#\s*Existing memory about the user:/i,   // memory cards, if they ever ride the tail
];

function looksInjected(text) {
  const t = stripContextReplay(text).trim();
  if (!t) return false;
  return DYNAMIC_TAIL_MARKERS.some((re) => re.test(t));
}

/* Read-only: which message of the trailing user-run is the person's, plus how
 * many injected ones sat in front of it. Returned together so the log line can
 * SHOW the skip — the next surprise blob shape should appear in a receipt, not
 * quietly poison a month of routing votes the way this one did. */
function autoThinkPersonPick(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  let end = msgs.length - 1;
  while (end >= 0 && (!msgs[end] || msgs[end].role !== 'user')) end--;
  if (end < 0) return { text: '', skipped: 0, runLen: 0 };
  let start = end;
  while (start - 1 >= 0 && msgs[start - 1] && msgs[start - 1].role === 'user') start--;
  const runLen = end - start + 1;
  for (let i = start; i <= end; i++) {
    const text = messageTextOf(msgs[i].content);
    if (!looksInjected(text)) return { text, skipped: i - start, runLen };
  }
  return { text: messageTextOf(msgs[start].content), skipped: 0, runLen };
}

function autoThinkPersonText(body) {
  return autoThinkPersonPick(body).text;
}

/* THE CONTEXT-REPLAY WRAPPER, and the receipt that found it (Part 66,
 * Aug 15 2026). Printing the excerpt HEAD as well as the tail settled the
 * open question from Part 65 immediately and unpleasantly: EVERY classified
 * turn in the live window logged
 *     (len 1500, run 2) "[EARLIER IN THIS CONVERSATION — context only, …"
 * — 1500 characters of replayed transcript, her actual sentence nowhere in
 * it. The router has been voting on machine text, not on what anybody said.
 *
 * Cause, and it is nobody's mistake twice: the proxy's composeTextWithHistory
 * folds prior turns into ONE user message with the transcript PREPENDED and
 * the person's words at the very END (inworld-tts-proxy/librechat.js) — that
 * is the voice/phone lane. Part 61 fixed the opposite shape on the typed lane,
 * where the fork APPENDS diary and platform blobs BEHIND her message, and the
 * fix there was "keep the FRONT." Both observations were correct about their
 * own lane, which is exactly why one log line could never settle it.
 *
 * So: strip the wrapper by its own literal delimiters rather than guessing at
 * either end. What is left is what the person actually said, wherever it sat.
 * If a message is nothing BUT wrapper, keep the original text — a bad excerpt
 * still beats an empty one, which would silently route everything to instant. */
const CONTEXT_REPLAY_RE = /\[EARLIER IN THIS CONVERSATION[\s\S]*?Reply ONLY to what follows\.\]/gi;

function stripContextReplay(text) {
  const cut = String(text || '').replace(CONTEXT_REPLAY_RE, ' ').trim();
  return cut.length >= 2 ? cut : String(text || '');
}

function autoThinkExcerpt(body) {
  return stripContextReplay(autoThinkPersonText(body))
    .replace(DEEP_THINK_RE, '')
    .replace(INSTANT_RE, '')
    .replace(/\[PHONE CALL[^\]]*\]/gi, '')
    .trim()
    .slice(0, 1500);
}

// How many user messages the trailing user-run held. The fork stacks
// platform-note/diary/memory blobs as SEPARATE user messages behind the
// person's turn, so run > 1 means blobs were stacked (and correctly skipped,
// since the excerpt keeps the FIRST message of the run); run === 1 with a
// blob visible in the excerpt means the blob is INSIDE her own message —
// a different bug with a different fix. Read-only, mirrors autoThinkPersonText.
function autoThinkRunLen(body) {
  return autoThinkPersonPick(body).runLen;
}

// The decision receipt, BOTH ends on purpose. Part 65 logged only the tail and
// caught a deep vote whose tail was a dated diary line — which by itself cannot
// say whether the router read her question (head hers, blob riding behind it)
// or never saw it at all (head also a blob). The question lives at the FRONT,
// so the head is the tell. Short excerpts print whole; no fake ellipsis.
function excerptReceipt(excerpt) {
  const flat = String(excerpt || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= 115) return flat;
  return `${flat.slice(0, 70)} … ${flat.slice(-40)}`;
}

/* THE DEEP LEXICON (widened Aug 17 2026 at her ask: "I definitely want more
 * turns reaching the classifier"). The original list was built around
 * QUESTIONS -- why/how/compare/decide. It missed the way she actually opens a
 * hard turn, which is usually a statement: "walk me through it", "I can't tell
 * if", "help me think", "I keep going back and forth". Live proof the night
 * this was widened: a 470-character message about whether to take a teaching
 * job -- guilt versus meaning, genuinely deliberation-shaped -- voted INSTANT
 * by heuristic, because it never used one of the old trigger words.
 * Also lowered the raw-length gate below from 600 to 350 for the same reason:
 * a long message is itself evidence someone is working something out.
 * The classifier is gemini-flash-lite at max_tokens 4 -- fractions of a cent
 * per call -- so the cost of asking more often is latency (~500ms), not money,
 * and the fast <140-char chatter path is deliberately untouched. */
const AUTO_DEEP_LEXICON = /\b(why|how (do|does|would|should|can|to)|explain|understand|plan|design|compare|versus|vs\.?|should (i|we)|help me (decide|figure|pick|choose|think|understand|make sense)|debug|analy[sz]e|strateg|calculat|math|prove|budget|worth it|pros and cons|difference between|what if|figure out|think through|advice|decide|walk me through|walk through (it|this)|talk me (through|into|out of)|can'?t tell if|not sure (if|whether)|torn|going back and forth|wrestling with|stuck on|struggling with|make sense of|process this|weigh|trade-?offs?|what do you think|thoughts on|sort (this|it) out|second.guess|overthink|makes me wonder|part of me)\b/i;

// Raw-length gate: over this, ask the classifier regardless of wording.
// Was 600 (Aug 14 - Aug 17 2026); her ask widened it. Tune: KADE_AUTO_CLASSIFY_MIN_LEN.
const AUTO_CLASSIFY_MIN_LEN = Number(process.env.KADE_AUTO_CLASSIFY_MIN_LEN || 350);

// Mid-band default (140 chars .. AUTO_CLASSIFY_MIN_LEN, no other signal).
// 'classify' since Aug 17 2026 at her word; set KADE_AUTO_CLASSIFY_MIDBAND=instant to revert.
const AUTO_CLASSIFY_MIDBAND =
  String(process.env.KADE_AUTO_CLASSIFY_MIDBAND || 'classify').toLowerCase() === 'instant' ? 'instant' : 'classify';

const AUTO_MATH_SHAPE = /\d\s*(%|percent)|\d\s*[*\/x×^]\s*\d/i;

function autoThinkHeuristic(excerpt) {
  const t = excerpt.trim();
  if (!t) return 'instant';
  if (AUTO_MATH_SHAPE.test(t)) return 'classify';
  if (t.length < 140 && !AUTO_DEEP_LEXICON.test(t) && !t.includes('```') && (t.match(/\?/g) || []).length < 2) {
    return 'instant';
  }
  if (t.length > AUTO_CLASSIFY_MIN_LEN || AUTO_DEEP_LEXICON.test(t) || t.includes('```') || (t.match(/\?/g) || []).length >= 2) {
    return 'classify';
  }
  /* THE MID BAND (Aug 17 2026, her second widening: "Send almost everything to
   * the classifier"). Anything between the 140-char chatter floor and the
   * length gate above used to default to INSTANT on the theory that a
   * medium-length message with no trigger word was small talk. It often
   * isn't -- it's someone saying a hard thing plainly, which is exactly the
   * shape the lexicon can't catch by construction. Now the router asks.
   * The <140 fast path above is untouched, so "hey" / "lol okay" / "thanks"
   * still cost nothing. Revert: KADE_AUTO_CLASSIFY_MIDBAND=instant. */
  return AUTO_CLASSIFY_MIDBAND;
}

/* THE ROUTER'S OWN MODEL (Aug 15 2026 — her call, "switch all those background
 * processes"). Moved off kimi-k2.6, and deliberately NOT to deepseek-v4-flash:
 * this call is hard-capped at AUTO_CLASSIFY_TIMEOUT_MS (1200ms) with instant as
 * the timeout answer, so a slow classifier doesn't fail loudly — it silently
 * turns auto-think OFF. Measured on classifier-shaped calls (max_tokens 4):
 *   deepseek-v4-flash  median 2078ms, worst 5521ms — 4 of 6 OVER the cap.
 *   gemini-2.5-flash-lite  median 460ms, worst 617ms — 0 of 6 over, and it got
 *   all three routing calls right (deep / quick / instant).
 * Flash-lite is also ~6.5x cheaper in and ~8.5x cheaper out than k2.6
 * ($0.10/$0.40 vs $0.65/$3.41 per M) and — the part that matters most — it
 * moves this per-turn burn OFF the Moonshot pot (the strained one that carries
 * the whole fleet) and onto OpenRouter. Same model the fork already uses for
 * titles. Non-kimi models route to OpenRouter automatically via
 * chatCompletionsUrl/chatHeaders, and adaptForKimi passes them through
 * untouched. Revert = put 'kimi-k2.6' back on this line. */
async function classifyThinkTier(excerpt, reqId) {
  const body = {
    model: 'google/gemini-2.5-flash-lite',
    messages: [
      { role: 'system', content: 'You route incoming chat messages to a thinking budget. Reply with exactly one word and nothing else. instant = greetings, small talk, reactions, roleplay banter, simple facts, requests a good friend answers without pausing. quick = benefits from a moment of real thought: everyday advice, explanations, small math, comparisons, feelings that deserve care. deep = genuinely hard: multi-step reasoning or planning, tricky math or logic, code, big or contested decisions.' },
      { role: 'user', content: excerpt },
    ],
    temperature: 0.6,
    reasoning_effort: 'none', // harmless on flash-lite; kept for an easy revert to k2.6
    max_tokens: 4,
    stream: false,
  };
  const t0 = Date.now();
  try {
    const r = await fetchWithTimeout(
      chatCompletionsUrl(body.model),
      { method: 'POST', headers: chatHeaders(body.model), body: JSON.stringify(adaptForGlm(adaptForKimi(body))) },
      AUTO_CLASSIFY_TIMEOUT_MS
    );
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const word = String(j?.choices?.[0]?.message?.content || '').toLowerCase();
    const tier = word.includes('deep') ? 'deep' : word.includes('quick') ? 'quick' : 'instant';
    console.log(`[auto-think][req ${reqId}] classifier -> ${tier} (${Date.now() - t0}ms)`);
    return tier;
  } catch (e) {
    console.log(`[auto-think][req ${reqId}] classifier fell back to instant (${e.message}, ${Date.now() - t0}ms)`);
    return 'instant';
  }
}

async function maybeAutoThink(body, reqId = '??????') {
  try {
    /* Part 67 (Aug 15): every silent exit now names itself. Her live web
     * turns produced ZERO auto-think lines while everything visible looked
     * eligible — kimi model, system+tools, no explicit choice — and the
     * quiet returns below made that undebuggable from logs alone. One line
     * per skip; the next mystery names its own gate. */
    if (!AUTO_DEEPTHINK || !isReasoningModel(body?.model)) {
      console.log(`[auto-think][req ${reqId}] skip: ${!AUTO_DEEPTHINK ? 'KADE_AUTO_DEEPTHINK=0' : `non-reasoning model (${String(body?.model || '(none)')})`}`);
      return body;
    }
    const r = body.reasoning || {};
    const effort = typeof r.effort === 'string' ? r.effort.toLowerCase() : '';
    // Someone already chose: deep marker/setting (enabled or a real effort).
    if (r.enabled === true || ['low', 'medium', 'high'].includes(effort)) {
      console.log(`[auto-think][req ${reqId}] skip: explicit choice already made (enabled=${r.enabled === true}, effort=${effort || '(none)'})`);
      return body;
    }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const hasSystem = msgs.some((m) => m && m.role === 'system');
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    if (!hasSystem && !hasTools) {
      console.log(`[auto-think][req ${reqId}] skip: bare title/summarizer shape`);
      return body; // titles/summaries: never think
    }
    /* CALLS RIDE AUTO TOO, CAPPED (Aug 14 2026, her ask: "let's turn the phone
     * line and app calls on auto too"). This used to be a flat skip — every
     * call turn was instant, always. Now the router runs on calls as well, but
     * a call can never be voted DEEP: deep measured ~12s on k2.6, and twelve
     * seconds of silence on a phone call reads as a dropped call (her dead-air
     * rule, which stands). Quick is +~2s over instant — a natural conversational
     * pause — so deep is capped down to quick and instant stays instant.
     * The escape hatch is unchanged and better than a cap: saying "think hard"
     * on a call sets a fresh [DEEP THINK] marker, which withReasoningIncluded
     * turns into effort:'high' BEFORE this function runs, and the explicit-choice
     * guard above returns early — so a caller who actually wants deep still gets
     * the full budget by asking out loud. Covers the app/web call lane too: the
     * bridge appends the same [PHONE CALL ...] suffix on those sessions. */
    const isCall = isPhoneTurn(body);
    const excerpt = autoThinkExcerpt(body);
    // Fresh explicit instant beats the router (button/setting/typed) —
    // read off the person's send, same message the excerpt uses.
    /* Same wrapper, same problem: a replayed transcript can contain a marker
     * from an EARLIER turn, and a stale [INSTANT] in the history must not
     * force this turn instant. Read the marker off her words only. */
    const forcedInstant = instantRequested(stripContextReplay(autoThinkPersonText(body)));
    const cleaned = stripInstantFromBody(body);
    if (forcedInstant) {
      console.log(`[auto-think][req ${reqId}] fresh [INSTANT] -> effort none, router skipped`);
      return { ...cleaned, reasoning: { ...(cleaned.reasoning || {}), effort: 'none', enabled: false, exclude: false } };
    }
    const heur = autoThinkHeuristic(excerpt);
    let tier = heur === 'classify' ? await classifyThinkTier(excerpt, reqId) : 'instant';
    if (isCall && tier === 'deep') {
      console.log(`[auto-think][req ${reqId}] call turn: deep capped to quick (dead-air rule)`);
      tier = 'quick';
    }
    if (tier === 'instant') {
      /* Part 67, the last silent path: heuristic-instant used to return with
       * no line at all — which read as "auto-think is broken" the first time
       * anyone checked the logs after the excerpt fix made real excerpts
       * short again. The file's own promise is one line per decision. */
      console.log(`[auto-think][req ${reqId}] -> instant (${heur === 'classify' ? 'classifier' : 'heuristic'}, len ${excerpt.length}, run ${autoThinkRunLen(body)}, skipped ${autoThinkPersonPick(body).skipped}) "${excerptReceipt(excerpt)}"`);
      /* INSTANT MUST BE SAID OUT LOUD ON THE GLM LANE (Aug 17 2026). On kimi,
       * returning the body untouched is safe: adaptForKimi's else-branch pins
       * reasoning_effort:'none' on every non-thinking turn, so instant really
       * is instant. GLM has no such pinning -- it goes straight to OpenRouter,
       * and a body with NO reasoning field lets the provider decide. Measured
       * consequence: the Morph provider chose to think, spent 1,037 tokens,
       * and returned ZERO content in 97 seconds. Agent params currently carry
       * reasoning_effort:'none' so the field is normally present, but "the
       * config happens to save us" is not a guarantee -- one agent created
       * without it would silently draw the 97-second turn. Say it explicitly. */
      return isGlmModel(cleaned.model)
        ? { ...cleaned, reasoning: { ...(cleaned.reasoning || {}), effort: 'none', enabled: false, exclude: false } }
        : cleaned; // kimi call turns keep the effort:'none' they arrived with
    }
    console.log(`[auto-think][req ${reqId}] -> ${tier} (len ${excerpt.length}, run ${autoThinkRunLen(body)}, skipped ${autoThinkPersonPick(body).skipped}) "${excerptReceipt(excerpt)}"`);
    /* ⚠️⚠️ BOTH TIERS SET `effort` EXPLICITLY. DO NOT GO BACK TO INHERITING IT.
     *
     * THE BUG THIS FIXES (Aug 19 2026, found in the live logs): the deep
     * branch used to be `{ ...cleaned.reasoning, enabled: true, exclude: false }`
     * -- it set `enabled` and `exclude` but NOT `effort`. The spread runs
     * first, so whatever the agent sent survived. Half the fleet carries
     * `reasoning_effort: 'none'` in its params, so a DEEP-voted turn shipped
     * `{ effort: 'none', enabled: true }` -- "reasoning on, at effort none",
     * which every provider that honours the flag resolves as OFF. QUICK was
     * accidentally immune because it writes `effort: 'low'` AFTER the spread,
     * clobbering the inherited 'none'. Hence the inversion Kade's logs showed:
     * QUICK THOUGHT AND DEEP DID NOT.
     *
     * WHY IT ONLY SURFACED NOW: the kimi lane never had this. `adaptForKimi`
     * DELETES the whole `reasoning` object and re-derives `reasoning_effort`
     * from scratch, translating only low/medium/high -- so an inherited 'none'
     * could never reach Moonshot as a suppressor. GLM goes straight to
     * OpenRouter with the object intact. The fleet moved to glm-5.2 on Aug 18
     * (221 of 223 agents); this went live with that move, silently.
     *
     * THE RECEIPTS (so nobody re-litigates this from theory):
     *   - live logs, 27h window: DEEP returned reasoning text on 0 of 16
     *     non-tool turns; QUICK on 9 of 17. INSTANT 0 of 35, correctly.
     *   - the control: same agent (system sha 77ec8b78, tools sha 39b0b858),
     *     same conversation, same evening -- 19:12 deep 0 chars, 19:18 deep
     *     0, 19:27 QUICK 1,101 chars, 19:32 deep 0. Only the tier varied.
     *   - a 12-call A/B on z-ai/glm-5.2 across 7 providers (DeepInfra,
     *     Ambient, DigitalOcean, Alibaba, Venice, Together, Sail Research):
     *       effort:'none' + enabled  -> 0 reasoning tokens, 3/3. DEAD.
     *       effort:'low'  + enabled  -> 203 / 433 / 214  (avg 283)
     *       enabled, no effort       -> 256 / 225 / 1015 (avg 499)
     *       effort:'high' + enabled  -> 1508 / 274 / 971 (avg 918)
     *     Not provider roulette: 'none' zeroed reasoning on every provider
     *     that drew it, 'low' and 'high' reasoned on every provider.
     *
     * WHY 'high' AND NOT BARE `enabled` (Kade's call, her words: "I'd like
     * auto think to cycle through different levels of deepthink based on the
     * complexity of the situation"): the tiers have to be RELIABLY different,
     * and 'high' is deterministic where a bare `enabled` leaves the budget to
     * the provider -- and provider roulette is a documented, repeat offender
     * in this file (see the title-reasoning comment in withReasoningIncluded).
     * 'high' is also exactly what an explicit [DEEP THINK] marker already
     * sends, so auto-deep and hand-asked deep now behave identically.
     * The ladder as shipped: instant = none, quick = low (~283 reasoning
     * tokens), deep = high (~918). Three levels that actually differ. */
    return {
      ...cleaned,
      reasoning: tier === 'deep'
        ? { ...(cleaned.reasoning || {}), effort: 'high', enabled: true, exclude: false }
        : { ...(cleaned.reasoning || {}), effort: 'low', enabled: true, exclude: false },
    };
  } catch (e) {
    console.log(`[auto-think][req ${reqId}] error, untouched: ${e.message}`);
    return body;
  }
}

function injectHermesThinking(body) {
  const msgs = Array.isArray(body.messages) ? body.messages.slice() : [];
  const i = msgs.findIndex((m) => m && m.role === 'system');
  if (i >= 0) {
    msgs[i] = { ...msgs[i], content: `${messageTextOf(msgs[i].content)}\n\n${HERMES_THINK_SYS}` };
  } else {
    msgs.unshift({ role: 'system', content: HERMES_THINK_SYS });
  }
  return { ...body, messages: msgs };
}

function withReasoningIncluded(body) {
  const existing = body.reasoning || {};
  /* TITLE / SUMMARIZER CALLS NEVER REASON (Aug 15 2026) — a hard floor, not a
   * per-model choice. This exact class of bug has now bitten twice: July 16,
   * glm-5.2's hidden think block ended up INSIDE generated titles ("junk in
   * titles"); Aug 15, deepseek-v4-flash spent the ENTIRE max_tokens budget on
   * reasoning and returned an EMPTY title (600 tokens of reasoning, no title,
   * ~9x the cost of a good one). Both times the fix was "pick a different
   * model," which is a fix that expires the next time someone changes
   * titleModel. So the guard lives here instead: title/summarizer requests
   * carry the whole conversation in ONE user message with no system message
   * and no tools — the same shape deepThinkRequested and maybeAutoThink
   * already use to refuse to deep-think them — and now they also get reasoning
   * pinned hard off, whatever model is configured. Cheap, silent, and it makes
   * ANY model safe as titleModel. */
  {
    // Same shape test appendReminder uses, shared so the two can never drift.
    if (isTitleShapedBody(body)) {
      /* Aug 18 2026 -- THE REASONING PIN IS NOT ENOUGH, so give the title a
       * budget it can survive. Her report: "conversation titling is messed up
       * majorly once again." Reproduced live: a title-shaped call to
       * deepseek-v4-flash came back `content: null`, finish_reason "length",
       * 41 REASONING tokens against a 40-token cap -- the model deliberated
       * and had nothing left to answer with. The `reasoning:{effort:'none',
       * enabled:false}` set right below is sent and IGNORED: OpenRouter's
       * reasoning-off toggle is honoured per-provider, not per-request, and
       * the same call routed to GMICloud reasoned while DigitalOcean and Sail
       * Research did not. That's provider roulette, which is exactly why this
       * breaks intermittently and why "pick a different model" kept expiring
       * as a fix (it has now bitten three times: July's junk-in-titles,
       * August 15th's empty titles, and tonight's).
       *
       * So the floor, not the flag, is the guarantee: a title that costs 256
       * tokens instead of 40 still costs $0.000005, and it leaves room for a
       * provider that insists on thinking to ALSO write the name. Only raises
       * a ceiling, never lowers one -- same shape as adaptForKimi's and
       * adaptForGlm's floors. Tune: KADE_TITLE_MIN_TOKENS. */
      const titleMax = Number(body.max_tokens);
      const titleFloor = Number(process.env.KADE_TITLE_MIN_TOKENS || 256);
      return withDeepThinkStripped({
        ...body,
        max_tokens: Number.isFinite(titleMax) ? Math.max(titleMax, titleFloor) : titleFloor,
        reasoning: { ...existing, effort: 'none', enabled: false, exclude: false },
      });
    }
  }
  // SHIM MODELS: never pass reasoning.enabled/effort (leaks raw CoT into
  // content on Nebius). Deep Think -> inject Hermes' thinking instruction.
  const isShimModel = TOOL_SHIM_MODELS.has(String(body.model || '').toLowerCase());
  if (isShimModel) {
    const cleaned = { ...existing };
    delete cleaned.enabled;
    delete cleaned.effort;
    let next = { ...body, reasoning: { ...cleaned, exclude: false } };
    if (deepThinkRequested(body)) {
      console.log('[deep-think] shim model -> Hermes thinking instruction injected (no reasoning.enabled)');
      next = injectHermesThinking(next);
    }
    return withDeepThinkStripped(next);
  }
  // Phone calls are marked by the kade-ai-bridge PHONE_SUFFIX ("[PHONE CALL ...")
  // in the last user message. For those, force reasoning effort to NONE (fully
  // off) — applies to EVERY agent on the phone. Verified live against OpenRouter
  // directly (2026-06-30): GLM-5.2 at effort:'low' barely differs from the
  // model's own default (56 vs 57 reasoning tokens on a test prompt, both left
  // the reply truncated on a tight token budget) so 'low' wasn't actually
  // buying the latency win this comment used to claim. effort:'none' is the
  // one that empirically zeroes reasoning tokens and answers instantly (same
  // test: 0 reasoning tokens, correct instant reply). Web traffic carries no
  // marker, so its path is byte-identical to before.
  const isPhone = isPhoneTurn(body);
  // DEEP THINK beats everything, including the phone effort:'none' override
  // and any agent-level reasoning_effort (Answer speed) setting: a fresh
  // per-message marker means the user explicitly asked THIS turn to think.
  // effort:'high' chosen over leaving effort unset because GLM-5.2 measured
  // (July 4 2026) low/medium/high -> one "High" tier at ~8s first token while
  // UNSET maps to the Max tier at ~11.8s -- 'high' is the depth win without
  // the worst-case latency.
  // July 30 2026 (session 35 part 2): the marker-scan is PHONE-ONLY now.
  // App/web turns carry an explicit reasoning flag from the fork's
  // buildOptions (which reads req.body.text -- immune to the injected
  // trailing user-role context block that defeated this scan), and title/
  // summarizer calls must never deep-think. Phone keeps the scan: the
  // bridge appends the marker to the caller's actual last message.
  const isDeep = isPhoneTurn(body) && deepThinkRequested(body);
  const reasoning = isDeep
    ? { ...existing, effort: 'high', enabled: true, exclude: false }
    : isPhone
      ? { ...existing, effort: 'none', exclude: false }
      : { ...existing, exclude: false };
  if (isDeep) console.log('[deep-think] fresh marker found -> reasoning effort high for this turn');
  return withDeepThinkStripped({ ...body, reasoning });
}

// -- streaming handler -------------------------------------------------------
// Reads OpenRouter's SSE stream. Buffers raw events until it can tell whether
// this is a TOOL-CALL turn (-> flip to live passthrough) or a pure CONTENT
// turn (-> buffer to end, detect/rewrite, emit fake SSE). Inactivity timeout
// guards against a stalled upstream provider mid-stream.
const STREAM_IDLE_TIMEOUT_MS = 90_000;

async function handleStreaming(req, res, upstreamBody, shimActive = false, shimDeepThink = false) {
  const reqId = req._reqId || '??????';
  const t0 = Date.now();
  // PHONE STREAMING FIX (July 1 2026): phone-marked turns stream content
  // through LIVE instead of buffering for slop detection. The Media Streams
  // bridge speaks sentence-by-sentence as tokens arrive, so buffering the
  // whole reply here made callers wait out the ENTIRE generation before the
  // first word played. Slop detect/rewrite is skipped for phone turns only
  // (you can't rewrite text that's already been spoken); web traffic is
  // byte-identical to before. Reasoning stripping still applies (phone runs
  // effort:'none' anyway, so reasoning deltas are not expected).
  // TOOL SHIM: shim turns must be fully buffered even on the phone — live-
  // forwarding would stream raw <tool_call> JSON into the TTS pipeline.
  const phoneLive = isPhoneTurn(upstreamBody) && !shimActive;
  // SHIM LIVE STREAMING (July 10 2026): shim turns used to be FULLY buffered
  // (web AND phone) so <tool_call> text could be parsed before anything
  // reached the client -- which meant every Hermes/Euryale persona reply sat
  // in total silence until the whole generation finished, then arrived as a
  // wall. Now shim turns stream content LIVE through a small state machine
  // that withholds only sentinel tags: plain text is emitted as it arrives;
  // the moment '<tool_call' shows up, emission stops and the rest of the turn
  // is buffered + parsed into real tool_calls at the end (so raw JSON can
  // never leak to the user or the TTS pipeline); inline '<think>' spans are
  // swallowed. Deep-Think shim turns keep the old full-buffer path: their
  // whole reply STARTS with a <think> block that needs the seed-chunk +
  // <think>-injection dance (see below) to render as a reasoning bubble.
  const shimLive = shimActive && !shimDeepThink;
  // Diagnostic: show the tail of the last user message so phone-marker
  // detection is verifiable from logs alone (the marker is a suffix).
  try {
    const msgs = Array.isArray(upstreamBody.messages) ? upstreamBody.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') {
        const c = msgs[i].content;
        const shape = typeof c === 'string' ? 'string' : Array.isArray(c) ? `array[${c.map((p) => p && p.type).join(',')}]` : typeof c;
        console.log(`[req ${reqId}] lastUser shape=${shape} tail=${JSON.stringify(messageTextOf(c).slice(-90))}`);
        break;
      }
    }
  } catch {}
  console.log(`[req ${reqId}] handleStreaming start, reasoning=${JSON.stringify(upstreamBody.reasoning)}${phoneLive ? ', PHONE turn -> live content passthrough' : ''}`);
  upstreamBody = await maybeAutoThink(upstreamBody, reqId);
  upstreamBody = adaptForGlm(adaptForKimi(upstreamBody));
  // Session 22 (Kade: "Check caching, because that saves money in multiple
  // places"): Moonshot k2.6 has AUTOMATIC prefix caching (proven live:
  // repeated ~9K-token prefix -> cached_tokens 8192, hit rate $0.16/M vs
  // $0.95/M miss, TTFT 2.8s -> 1.3-2.0s) -- but production call turns showed
  // ZERO benefit (turn 1: 2.9s headers, turns 2-3: 5.3s+), meaning something
  // in the payload head changes per turn and kills the prefix match. Two
  // receipts to name the breaker: (a) per-message fingerprints (role, chars,
  // sha1-8) -- diff consecutive turns' lines and the first changed hash IS
  // the breaker; (b) ask Moonshot for stream usage so cached_tokens lands in
  // the read-loop-ended line. The usage-only frame is swallowed below when
  // WE added the request for it -- the client never asked, never sees it.
  let addedUsage = false;
  if (/^kimi-/.test(String(upstreamBody.model)) && upstreamBody.stream && !upstreamBody.stream_options) {
    upstreamBody = { ...upstreamBody, stream_options: { include_usage: true } };
    addedUsage = true;
  }
  try {
    const fps = (Array.isArray(upstreamBody.messages) ? upstreamBody.messages : []).map((m) => {
      const t = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      // Aug 5 2026 (cache-nibbler hunt): name the SHAPE too -- an assistant
      // message re-rendering array->string between turns is byte-noise that
      // breaks the prefix at that message even when the visible text never
      // changed (receipt: 1010ch array vs 919ch string, same stored reply).
      const shape =
        typeof m.content === 'string'
          ? 's'
          : Array.isArray(m.content)
            ? `a[${m.content.map((p) => (p && p.type) || '?').join(',')}]`
            : typeof m.content;
      return `${m.role}:${shape}:${t.length}ch:${crypto.createHash('sha1').update(t).digest('hex').slice(0, 8)}`;
    });
    console.log(`[req ${reqId}] msg-fingerprints: ${fps.join(' | ')}`);
    // Aug 4 2026 cache hunt: tools serialize AHEAD of messages in provider
    // prompt caches -- a per-turn wobble here zeroes every hit even when all
    // messages are byte-stable. Hash the exact serialized form.
    if (Array.isArray(upstreamBody.tools) && upstreamBody.tools.length > 0) {
      const tjson = JSON.stringify(upstreamBody.tools);
      console.log(`[req ${reqId}] tools-fingerprint: ${upstreamBody.tools.length} tools, ${tjson.length}ch, sha ${crypto.createHash('sha1').update(tjson).digest('hex').slice(0, 8)}`);
    }
  } catch {}
  let upstream;
  // July 30 2026: same transient-status patience as callOpenRouter above --
  // safe HERE because nothing has been written to `res` until after the
  // status check below, so a retried fetch is invisible to the client.
  for (let attempt = 0; ; attempt++) {
    try {
      upstream = await fetchWithTimeout(
        chatCompletionsUrl(upstreamBody.model),
        { method: 'POST', headers: chatHeaders(upstreamBody.model), body: JSON.stringify(upstreamBody) },
        STREAM_IDLE_TIMEOUT_MS
      );
    } catch (err) {
      const status = err.name === 'AbortError' ? 504 : 502;
      console.error(`[req ${reqId}] initial fetch failed after ${Date.now() - t0}ms: ${err.name} ${err.message}`);
      return res.status(status).set('Content-Type', 'application/json').send(
        JSON.stringify({ error: { message: 'Upstream request failed', type: 'upstream_error' } })
      );
    }
    if (upstream.ok || attempt >= 2 || !TRANSIENT_UPSTREAM_STATUSES.has(upstream.status)) break;
    const wait = transientRetryDelayMs(attempt, upstream.headers.get('retry-after'));
    console.warn(`[req ${reqId}] upstream ${upstream.status} (attempt ${attempt + 1} of 3) -- retrying in ${wait}ms`);
    try { await upstream.text(); } catch {}
    await sleepMs(wait);
  }
  console.log(`[req ${reqId}] upstream headers received after ${Date.now() - t0}ms, status=${upstream.status}, content-type=${upstream.headers.get('content-type')}`);

  if (!upstream.ok && shouldFallbackToOpenRouter(upstreamBody.model, upstream.status)) {
    // Moonshot balance fallback (Aug 4 2026): same request, OpenRouter's kimi
    // hosting, so a drained Moonshot balance degrades the fleet instead of
    // killing it. Nothing has been written to `res` yet, so this retry is
    // invisible to the client.
    const fbBody = moonshotFallbackBody(upstreamBody);
    if (fbBody) {
      try { await upstream.text(); } catch {}
      console.error(`[req ${reqId}] MOONSHOT FALLBACK ACTIVE (stream, status ${upstream.status}) -- retrying ${fbBody.model} via OpenRouter. TOP UP THE MOONSHOT BALANCE.`);
      try {
        upstream = await fetchWithTimeout(
          `${OPENROUTER_BASE}/chat/completions`,
          { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(fbBody) },
          STREAM_IDLE_TIMEOUT_MS
        );
      } catch (fbErr) {
        console.error(`[req ${reqId}] fallback fetch failed: ${fbErr.message}`);
      }
    }
  }
  if (!upstream.ok) {
    const text = await upstream.text();
    console.error(`[req ${reqId}] upstream not ok: ${upstream.status} ${text.slice(0,300)}`);
    const friendly = friendlyErrorBody(upstream.status, text);
    return res.status(upstream.status).set('Content-Type', 'application/json').send(friendly || text);
  }

  // Some providers ignore stream:true and return plain JSON. Handle that.
  const ctype = upstream.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream')) {
    const text = await upstream.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      return res.status(502).set('Content-Type', 'application/json').send(
        JSON.stringify({ error: { message: 'Upstream returned non-stream, non-JSON body' } })
      );
    }
    if (!(shimActive && parseShimToolCalls(json))) {
      await detectAndRewrite(json, upstreamBody);
    }
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    return res.send(buildFakeSSE(json));
  }

  // Open the SSE response to LibreChat IMMEDIATELY, not lazily once we know
  // whether this is a tool-call or content turn. Content turns get fully
  // buffered server-side below (that's the whole point of the slop filter —
  // see file header), which on a slow xhigh-reasoning reply can mean 30-90s
  // of total silence on the wire. LibreChat's client registers/tracks a
  // streamId off the FIRST bytes of the response; if none arrive for that
  // long, it gives up and tries to "resume" a stream it never got an id for
  // (-> "[AgentStream] Job not found for streamId: undefined" in LibreChat's
  // logs, repeating every time this happens) and the chat just hangs, even
  // though the proxy and OpenRouter are both working fine underneath. Fix:
  // open headers right away and emit a no-op SSE comment heartbeat every few
  // seconds while buffering, so the connection never goes dark long enough
  // to trip that client-side give-up/resume logic. Comment lines (":...")
  // are part of the SSE spec specifically for this purpose and are ignored
  // by every spec-compliant parser, so this is invisible to the final reply.
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  const HEARTBEAT_MS = 10_000;
  let heartbeatTimer = setInterval(() => {
    if (!res.writableEnded) {
      try { res.write(': keep-alive\n\n'); } catch (e) {}
    }
  }, HEARTBEAT_MS);
  function stopHeartbeat() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let rawPending = ''; // raw SSE text buffered until mode is decided
  let toolMode = false;
  let contentAccum = '';
  let reasoningAccum = '';
  let reasoningLive = false; // Aug 4 2026: reasoning deltas forwarded live this turn (see the reasoning branch)
  let template = null; // first parsed chunk, reused to shape the fake SSE on content turns
  let finishReason = 'stop';
  let usage = null;
  let sawDone = false;      // phoneLive: whether upstream's [DONE] was already forwarded
  let phoneFirstWrite = 0;  // phoneLive: t of first live content byte (latency logging)

  // -- shim live-streaming state machine (only used when shimLive) -----------
  const SHIM_SENTINELS = ['<tool_call', '<think'];
  let shimMode = 'text';        // 'text' | 'think' | 'captured'
  let shimProcessed = 0;        // index into contentAccum the machine has consumed
  let shimCaptureStart = -1;    // where the captured (tool-call) region begins
  let shimFirstWrite = 0;

  function shimChunkBase() {
    return {
      id: template?.id,
      object: 'chat.completion.chunk',
      created: template?.created,
      model: template?.model || upstreamBody.model,
    };
  }
  function emitShimContent(piece) {
    if (!piece || res.writableEnded) return;
    // delta.role present on every chunk -- the July 1 2026 langchain-typing lesson.
    const c = { ...shimChunkBase(), choices: [{ index: 0, delta: { role: 'assistant', content: piece }, finish_reason: null }] };
    res.write(`data: ${JSON.stringify(c)}\n\n`);
    if (!shimFirstWrite) {
      shimFirstWrite = Date.now();
      console.log(`[req ${reqId}] shim-live: first content emitted at ${shimFirstWrite - t0}ms`);
    }
  }
  /**
   * Emits everything in contentAccum that is safely plain text. Withholds:
   * (a) a partial '<'-prefix that could still become a sentinel tag (waits for
   * more bytes; `force` flushes it at stream end), (b) '<think>' span contents
   * (swallowed entirely), (c) everything from '<tool_call' onward ('captured' --
   * parsed into tool_calls after the stream ends).
   */
  function drainShim(force) {
    while (true) {
      if (shimMode === 'captured') return;
      const pending = contentAccum.slice(shimProcessed);
      if (!pending) return;
      if (shimMode === 'think') {
        const end = pending.toLowerCase().indexOf('</think>');
        if (end === -1) {
          // keep a small tail so a '</think' split across deltas still matches
          shimProcessed += force ? pending.length : Math.max(0, pending.length - 8);
          return;
        }
        shimProcessed += end + 8;
        shimMode = 'text';
        continue;
      }
      const lt = pending.indexOf('<');
      if (lt === -1) {
        emitShimContent(pending);
        shimProcessed += pending.length;
        return;
      }
      if (lt > 0) {
        emitShimContent(pending.slice(0, lt));
        shimProcessed += lt;
        continue;
      }
      const low = pending.toLowerCase();
      let matched = null;
      let couldMatch = false;
      for (const sentinel of SHIM_SENTINELS) {
        if (low.startsWith(sentinel)) { matched = sentinel; break; }
        if (!force && low.length < sentinel.length && sentinel.startsWith(low)) { couldMatch = true; }
      }
      if (matched === '<tool_call') {
        shimMode = 'captured';
        shimCaptureStart = shimProcessed;
        console.log(`[req ${reqId}] shim-live: <tool_call detected at ${Date.now() - t0}ms -> capturing rest of turn`);
        return;
      }
      if (matched === '<think') {
        shimMode = 'think';
        shimProcessed += matched.length;
        continue;
      }
      if (couldMatch) return; // partial sentinel prefix -- wait for more bytes
      emitShimContent('<');
      shimProcessed += 1;
    }
  }

  function startPassthrough(currentEvent, leftoverBuffer) {
    toolMode = true;
    console.log(`[req ${reqId}] tool_calls detected -> live passthrough at ${Date.now() - t0}ms`);
    stopHeartbeat();
    // Flush, in order: (1) any earlier buffered text/non-reasoning events,
    // (2) the CURRENT event -- the one that actually carries the tool_calls
    // delta itself (id/name/first argument fragment). This used to get
    // silently dropped: the old code called startPassthrough() and broke
    // out of both loops before this event's own rawEvent string was ever
    // added to rawPending, so on any reply where the model went straight to
    // a tool call with little/no preceding narration text, the WHOLE turn's
    // tool_calls payload could vanish -- LibreChat got an empty response,
    // no text and no tool call, even though OpenRouter sent real data the
    // whole time. (3) leftoverBuffer -- whatever was still sitting in
    // sseBuffer waiting on a "\n\n" boundary that hadn't arrived yet when we
    // decided to flip modes. All of it is forwarded as raw bytes; the
    // client's own SSE parser doesn't care about our internal chunk/event
    // boundaries, so simply concatenating and writing once is safe.
    let flush = rawPending;
    if (currentEvent) flush += currentEvent + '\n\n';
    if (leftoverBuffer) flush += leftoverBuffer;
    if (flush) res.write(flush);
    rawPending = '';
  }

  function readWithIdleTimeout() {
    return Promise.race([
      reader.read(),
      new Promise((_, reject) =>
        setTimeout(() => reject(Object.assign(new Error('idle timeout'), { name: 'IdleTimeout' })), STREAM_IDLE_TIMEOUT_MS)
      ),
    ]);
  }

  try {
    while (true) {
      const { done, value } = await readWithIdleTimeout();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      if (toolMode) {
        // already committed to live passthrough — forward raw bytes as-is
        res.write(text);
        continue;
      }
      sseBuffer += text;

      // parse complete SSE events (separated by blank line) for inspection.
      // rawPending is rebuilt PER-EVENT below (only for events we decide not
      // to handle immediately) rather than from the raw network bytes, so
      // that reasoning events forwarded live (see below) are never replayed
      // a second time if a tool_call shows up later in the same turn.
      let idx;
      while ((idx = sseBuffer.indexOf('\n\n')) !== -1) {
        const rawEvent = sseBuffer.slice(0, idx);
        sseBuffer = sseBuffer.slice(idx + 2);
        const lines = rawEvent.split('\n');
        let handledLive = false;
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { sawDone = true; continue; }
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch (e) {
            continue;
          }
          if (!template) template = chunk;
          if (chunk.usage) usage = chunk.usage;
          if (addedUsage && chunk.usage && (!Array.isArray(chunk.choices) || chunk.choices.length === 0)) {
            handledLive = true; // usage-only frame we asked for ourselves -- logged at loop end, never forwarded
          }
          const delta = chunk.choices?.[0]?.delta || {};
          const fr = chunk.choices?.[0]?.finish_reason;
          if (fr) finishReason = fr;
          if (delta.tool_calls) {
            // Pass the triggering event + whatever's left unparsed in
            // sseBuffer so nothing already-received gets thrown away.
            startPassthrough(rawEvent, sseBuffer);
            sseBuffer = '';
            break;
          }
          const reasoningText =
            typeof delta.reasoning === 'string' ? delta.reasoning :
            typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';
          if (reasoningText.length > 0) {
            // Aug 4 2026 (Kade: "I still don't see thoughts populating the
            // bubble until streaming is basically done"): reasoning deltas
            // now go downstream LIVE for web/app turns, so the thinking
            // bubble fills as the model thinks instead of all at once at the
            // end. The old fear (ON_REASONING_DELTA dispatched but the
            // browser stepMap lookup returned null, June era) is dead in
            // @librechat/agents 3.2.46: getMessageId() MINTS an id when none
            // exists, so the first live reasoning chunk dispatches
            // ON_RUN_STEP itself and every delta after it renders. Each
            // chunk is fabricated in the exact shape of the proven seed
            // chunk below (delta.role present -- the July 1 2026 langchain
            // typing lesson -- plus delta.reasoning, which this stack
            // provably routes into additional_kwargs, since the seed works).
            // PHONE turns keep the empty-content heartbeat: the bridge's
            // TTS pipeline must never meet thoughts (Kade's explicit rule:
            // thoughts are never spoken). SHIM turns keep it too -- their
            // deep path still needs the full-buffer <think> dance.
            reasoningAccum += reasoningText;
            // CRITICAL: delta.role must be present. These fabricated heartbeats
            // are usually the FIRST chunks LibreChat sees on a reasoning turn,
            // and langchain types the entire aggregated reply off the first
            // chunk's role. With role missing it builds a generic
            // ChatMessageChunk, and every concat() after that KEEPS that class
            // -- silently dropping tool_call_chunks from the real AIMessage
            // chunks that follow. Net effect (live-reproduced July 1 2026):
            // streaming agents could never execute tools -- the args streamed
            // in, the aggregated message lost them, the agent graph routed to
            // END, the turn saved with text:"" and args:"". This one missing
            // property was the whole "streaming agents are tool-broken" bug.
            const forwardReasoningLive = !phoneLive && !shimActive;
            const heartbeat = {
              id: chunk.id,
              object: chunk.object || 'chat.completion.chunk',
              created: chunk.created,
              model: chunk.model,
              choices: [{
                index: 0,
                delta: forwardReasoningLive
                  // BOTH field spellings on purpose. @langchain/openai 1.5.0
                  // (the fork's pinned converter, converters/completions.js
                  // line 264) maps ONLY delta.reasoning_content into
                  // additional_kwargs -- delta.reasoning is silently dropped
                  // (the old seed chunk's field never actually mapped; the
                  // dance worked via <think>-in-content, proven Aug 4 when a
                  // reasoning-only live test stored no think part). Keeping
                  // `reasoning` too is free future-proofing; even if both map
                  // someday, dispatch happens once per chunk, no doubling.
                  ? { role: 'assistant', content: '', reasoning: reasoningText, reasoning_content: reasoningText }
                  : { role: 'assistant', content: '' },
                finish_reason: null,
              }],
            };
            res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
            if (forwardReasoningLive && !reasoningLive) {
              reasoningLive = true;
              console.log(`[req ${reqId}] reasoning streaming LIVE (first delta at ${Date.now() - t0}ms)`);
            }
            handledLive = true;
          }
          if (typeof delta.content === 'string') {
            contentAccum += delta.content;
            if (shimLive && delta.content.length > 0) {
              drainShim(false);
              handledLive = true;
            }
          }
        }
        if (toolMode) break;
        if (phoneLive && !handledLive) {
          // PHONE turn: forward this event (content delta / finish / usage /
          // [DONE]) downstream immediately. Never buffered into rawPending,
          // never slop-rewritten. Reasoning events were already replaced by
          // empty-content heartbeats above (handledLive), same as web.
          if (!phoneFirstWrite) {
            phoneFirstWrite = Date.now();
            console.log(`[req ${reqId}] phone: first live event forwarded at ${phoneFirstWrite - t0}ms`);
          }
          /* Best-effort artifact scrub on phone-live events (whole tokens in
           * one delta; split-across-deltas fragments are caught by the TTS
           * proxy's own net). Only offending events get re-serialized. */
          let phoneOut = rawEvent;
          try {
            const pl = chunk.choices?.[0]?.delta;
            if (pl && typeof pl.content === 'string' && pl.content.length > 0) {
              const scrubbedDelta = scrubSearchArtifacts(pl.content);
              if (scrubbedDelta !== pl.content) {
                pl.content = scrubbedDelta;
                phoneOut = `data: ${JSON.stringify(chunk)}`;
              }
            }
          } catch (e) { /* forward raw over breaking a phone turn */ }
          res.write(phoneOut + '\n\n');
          continue;
        }
        if (!handledLive && !shimLive) {
          rawPending += rawEvent + '\n\n';
        }
      }
      if (toolMode) {
        // flush anything still buffered (rawPending was reset in startPassthrough,
        // but bytes parsed into sseBuffer leftover are already inside rawPending's
        // original write; remaining partial event will arrive on next read)
        continue;
      }
    }
  } catch (err) {
    console.error(`[req ${reqId}] streaming read error at ${Date.now() - t0}ms: ${err.name} ${err.message}, contentAccum.length=${contentAccum.length}, toolMode=${toolMode}`);
    stopHeartbeat();
    if (toolMode) {
      // already streaming live; best we can do is end the response
      try { res.end(); } catch (e) {}
      return;
    }
    // fall through to content handling with whatever we accumulated
  }

  stopHeartbeat();
  console.log(`[req ${reqId}] read loop ended at ${Date.now() - t0}ms, toolMode=${toolMode}, contentAccum.length=${contentAccum.length}, reasoningAccum.length=${reasoningAccum.length}, finishReason=${finishReason}`);
  if (usage) {
    const cached = (usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens) ?? usage.cached_tokens ?? 0;
    console.log(`[req ${reqId}] upstream usage: prompt=${usage.prompt_tokens ?? '?'} cached=${cached} completion=${usage.completion_tokens ?? '?'}${cached ? ` -- CACHE HIT ${Math.round((cached / (usage.prompt_tokens || 1)) * 100)}%` : ' -- no cache hit'}`);
  }

  if (toolMode) {
    // live passthrough already wrote everything incl. upstream's [DONE]
    console.log(`[req ${reqId}] tool-mode response ended at ${Date.now() - t0}ms`);
    try { res.end(); } catch (e) {}
    return;
  }

  if (shimLive) {
    drainShim(true); // flush any withheld tail (unclosed <think> content stays swallowed)
    if (shimMode === 'captured') {
      const captured = contentAccum.slice(shimCaptureStart);
      const pseudo = {
        id: template?.id,
        object: 'chat.completion',
        created: template?.created,
        model: template?.model || upstreamBody.model,
        choices: [{ index: 0, message: { role: 'assistant', content: captured }, finish_reason: 'stop' }],
        usage,
      };
      if (parseShimToolCalls(pseudo)) {
        // buildFakeSSE emits any leftover remainder text + the tool_calls delta +
        // finish 'tool_calls' + [DONE]. Text emitted live before the capture point
        // is NOT in `pseudo`, so nothing repeats.
        res.write(buildFakeSSE(pseudo));
        try { res.end(); } catch (e) {}
        console.log(`[req ${reqId}] shim-live: tool turn done at ${Date.now() - t0}ms (${pseudo.choices[0].message.tool_calls.length} call(s), ${shimCaptureStart} chars streamed live first)`);
        return;
      }
      // Unparseable capture -> show the raw text rather than half-execute (same
      // policy as the buffered path).
      emitShimContent(captured);
    }
    const fin = { ...shimChunkBase(), choices: [{ index: 0, delta: {}, finish_reason: finishReason || 'stop' }] };
    try {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(fin)}\n\n`);
        res.write('data: [DONE]\n\n');
      }
      res.end();
    } catch (e) {}
    console.log(`[req ${reqId}] shim-live: content turn done at ${Date.now() - t0}ms, ${contentAccum.length} chars, first byte at ${shimFirstWrite ? shimFirstWrite - t0 : -1}ms`);
    return;
  }

  if (phoneLive) {
    // PHONE turn: every content/finish event already went out live. If the
    // upstream ended without a [DONE] (error/idle mid-stream), close the SSE
    // shape ourselves so the fork's parser terminates cleanly.
    console.log(`[req ${reqId}] phone live-stream ended at ${Date.now() - t0}ms, ${contentAccum.length} chars streamed, first byte at ${phoneFirstWrite ? phoneFirstWrite - t0 : -1}ms`);
    try {
      if (!sawDone && !res.writableEnded) res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {}
    return;
  }

  // July 30 2026 (Amber's limerick receipts, session 35 part 2): a Deep
  // Think turn can spend its ENTIRE token budget deliberating -- the read
  // loop ends finishReason=length with thousands of reasoning chars and
  // ZERO content, and the person gets a wordless turn (the native app's
  // old fallback line then blamed "tool activity," which is how this got
  // reported as "it keeps calling tools"). When that exact signature shows
  // up on the kimi lane, re-ask ONCE with reasoning OFF (buffered, rides
  // the transient retries): the person gets the plain answer and the
  // reasoning bubble still shows the deliberation that ran long. Fail-soft
  // top to bottom -- if the re-ask dies too, the turn proceeds exactly as
  // it would have before this existed. (Known gap, deliberate: the
  // fallback call's tokens aren't merged into `usage`, so such a turn
  // under-meters by one fast-lane completion.)
  /* Aug 17 2026 (Part 72): generalized from isKimiModel to isReasoningModel.
   * GLM can produce this exact signature -- measured live, the Morph provider
   * returned finish=length with 4,079 reasoning chars and no content at all --
   * and until now the net only caught it on the kimi lane, so a GLM turn that
   * hit it just handed the person silence. Same cure, same fail-soft. */
  if (
    isReasoningModel(upstreamBody.model) &&
    finishReason === 'length' &&
    contentAccum.length === 0 &&
    reasoningAccum.length > 0
  ) {
    console.warn(`[req ${reqId}] reasoning ate the whole budget (finish=length, 0 content, ${reasoningAccum.length} reasoning chars) -- re-asking once with reasoning off`);
    try {
      const fallbackBody = { ...upstreamBody, stream: false };
      delete fallbackBody.stream_options;
      delete fallbackBody.reasoning;
      delete fallbackBody.include_reasoning;
      delete fallbackBody.reasoning_effort;
      const fb = await callOpenRouter(fallbackBody);
      const fbText = fb && fb.choices && fb.choices[0] && fb.choices[0].message && fb.choices[0].message.content;
      if (typeof fbText === 'string' && fbText.trim().length > 0) {
        contentAccum = fbText;
        finishReason = (fb.choices[0].finish_reason) || 'stop';
        console.log(`[req ${reqId}] reasoning-off fallback landed ${fbText.length} chars at ${Date.now() - t0}ms`);
      } else {
        console.warn(`[req ${reqId}] reasoning-off fallback returned no content -- leaving the turn as it was`);
      }
    } catch (fbErr) {
      console.warn(`[req ${reqId}] reasoning-off fallback failed: ${fbErr.message} -- leaving the turn as it was`);
    }
  }

  // pure CONTENT turn: build a buffered result, detect/rewrite, emit fake SSE
  const result = {
    id: template?.id,
    object: 'chat.completion',
    created: template?.created,
    model: template?.model || upstreamBody.model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: contentAccum },
        finish_reason: finishReason,
      },
    ],
    usage,
  };
  if (shimActive && parseShimToolCalls(result)) {
    // Shimmed tool-call turn: emit the tool_calls SSE as-is. Never slop-
    // rewritten (tool JSON must survive byte-perfect), never think-injected
    // (a tool_calls message has no displayable content slot for it).
    if (!res.headersSent) {
      res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    }
    res.write(buildFakeSSE(result));
    res.end();
    console.log(`[req ${reqId}] tool-shim turn sent at ${Date.now() - t0}ms (${result.choices[0].message.tool_calls.length} call(s))`);
    return;
  }
  await detectAndRewrite(result, upstreamBody);
  // If reasoning was collected, trigger the bubble via @librechat/agents'
  // think_and_text path:
  //
  //   Step 1 — seed chunk: write a single SSE chunk with delta.reasoning set
  //   to a zero-width space ('\u200B'). @librechat/agents' handleReasoning()
  //   sets agentContext.tokenTypeSwitch = "reasoning" on any non-empty
  //   delta.reasoning. That flag is required for the think_and_text transition
  //   on the next chunk (step 2). The seed also triggers ON_RUN_STEP →
  //   browser stepMap, which the ON_REASONING_DELTA handler needs.
  //
  //   Step 2 — inject <think> in content: prepend <think>reasoning</think> to
  //   the content that buildFakeSSE puts into delta.content. When that chunk
  //   arrives after the seed, ChatModelStreamHandler sees tokenTypeSwitch=
  //   "reasoning" + non-empty text → transitions to think_and_text → calls
  //   parseThinkingContent("<think>...</think>answer") → extracts {thinking,
  //   text} → dispatchReasoningDelta(stepId, {think: reasoning}) +
  //   dispatchMessageDelta(newStepId, {text: answer}) → ON_REASONING_DELTA
  //   SSE → browser → Reasoning.tsx collapsible bubble. ✓
  //
  // Why this survives the issues that killed ":::thinking:::" (June 28 2026):
  // that marker was embedded in result.choices[0].message.content which
  // LibreChat stores as flat text → corrupted auto-titles; TTS fragmentation
  // split the open/close tags across requests → strip regex failed. Here the
  // <think> block is in the STREAMING DELTA only; @librechat/agents' own
  // think_and_text path splits it into structured THINK+TEXT content parts
  // before storage. LibreChat saves [{type:"think",...},{type:"text",...}] so
  // auto-titling and TTS only ever see the text part — zero contamination. ✓
  if (reasoningLive) {
    // Aug 4 2026: thoughts already streamed live as delta.reasoning --
    // re-injecting them here would render the whole block a second time
    // (the live bubble would double). The agents lib aggregates the live
    // deltas into the SAME stored think part the injection used to
    // create, so persistence/auto-title/TTS behavior is unchanged.
    console.log(`[req ${reqId}] reasoning streamed live (${reasoningAccum.length} chars) -- <think> injection skipped`);
  } else if (reasoningAccum.length > 0 && result.choices[0].message.content.length > 0) {
    const seed = {
      id: result.id,
      object: 'chat.completion.chunk',
      created: result.created,
      model: result.model,
      choices: [{ index: 0, delta: { role: 'assistant', reasoning: '\u200B', content: '' }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(seed)}\n\n`);
    result.choices[0].message.content =
      `<think>\uF001${reasoningAccum}\uF002</think>${result.choices[0].message.content}`;
    console.log(`[req ${reqId}] injected <think> block (${reasoningAccum.length} chars) into synthetic content`);
  }
  if (!res.headersSent) {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  }
  res.write(buildFakeSSE(result));
  res.end();
  console.log(`[req ${reqId}] content-turn response sent at ${Date.now() - t0}ms, finalLength=${result.choices[0].message.content.length}`);
}

// -- main route --------------------------------------------------------------
// Part 68 (Aug 15 2026): deepseek-v4-flash writes literal special-token TEXT
// -- "<|end_of_sentence|>" -- into generated conversation titles (seen live on
// camera in the App-Review recording). Same hard-floor philosophy as the
// never-reason guard in withReasoningIncluded: scrub title/summarizer response
// CONTENT of <|...|> token text server-side, whatever model is configured, so
// the fix can't expire when someone changes titleModel. Title/summarizer calls
// are the no-system no-tools shape (checked on the ORIGINAL request body);
// real agent turns always carry a system message and are never touched.
function scrubSpecialTokensFromTitleReply(result, originalBody) {
  try {
    const msgs = Array.isArray(originalBody.messages) ? originalBody.messages : [];
    const hasSystem = msgs.some((m) => m && m.role === 'system');
    const hasTools = Array.isArray(originalBody.tools) && originalBody.tools.length > 0;
    if (hasSystem || hasTools) return;
    for (const c of (result && result.choices) || []) {
      if (c && c.message && c.message.content == null) {
        console.warn('[title-scrub] EMPTY title reply (content was null) -- a provider spent the whole budget reasoning.');
      }
      if (c && c.message && typeof c.message.content === 'string') {
        const before = c.message.content;
        /* Aug 18 2026 -- THE TOKEN IS A DELIMITER, NOT JUST LITTER.
         * Her report: "conversation titling is messed up majorly once again."
         * The live receipt that explains it, 08:58:43Z:
         *   " You're in the same time zone.<|...|>Menstrual disc sizing: body vs"
         * deepseek-v4-flash finished a STRAY LEFTOVER SENTENCE, emitted its
         * end-of-sentence token, and only THEN wrote the real title. The
         * Part-68 scrub deleted the token -- correctly -- but deleting a
         * delimiter GLUES the junk to the title with no space, which is
         * exactly the mess she saw:
         *   "You're in the same time zone.Menstrual disc sizing: body vs."
         * So: split on the token and keep the LAST non-empty segment (the
         * model's final answer -- the title it actually wrote), rather than
         * concatenating everything either side of a separator. Falls back to
         * the old whole-string scrub if splitting yields nothing, so a title
         * can never come back empty. */
        /* Aug 18 2026 -- THE REGEX NEVER MATCHED THE REAL TOKEN. DeepSeek's
         * end-of-sentence marker uses FULL-WIDTH pipes: <｜end▁of▁sentence｜>
         * (U+FF5C), not the ASCII <|...|> this pattern was written for. Found
         * by reading her actual database: a stored title still carried
         * "...body vs. flow<｜end▁of▁sentence｜>" AFTER the scrub had "run" --
         * the log line that looked like a successful scrub was only the
         * whitespace trim doing the work. Both pipe forms now. */
        const TOKEN_RE = /<[|\uFF5C][^|\uFF5C<>]{1,48}[|\uFF5C]>/g;
        const flat = before.replace(TOKEN_RE, '').replace(/[ \t]{2,}/g, ' ').trim();
        let after = flat;
        if (TOKEN_RE.test(before)) {
          TOKEN_RE.lastIndex = 0;
          const segments = before
            .split(TOKEN_RE)
            .map((seg) => seg.replace(/[ \t]{2,}/g, ' ').trim())
            .filter(Boolean);
          if (segments.length > 1) {
            after = segments[segments.length - 1];
            console.log(`[title-scrub] token was a DELIMITER -- kept the last of ${segments.length} segments`);
          } else if (segments.length === 1) {
            after = segments[0];
          }
        }
        if (!before.trim()) {
          console.warn('[title-scrub] EMPTY title reply -- a provider spent the whole budget reasoning. Raise KADE_TITLE_MIN_TOKENS or change titleModel.');
        }
        /* Never hand back an EMPTY title: a reply that was nothing but a
         * token would otherwise scrub down to "" and the conversation would
         * lose its name entirely. An ugly title beats a nameless thread --
         * same fail-soft philosophy as the catch below. */
        if (after && after !== before) {
          c.message.content = after;
          /* Log the FULL raw reply, not the first 60 chars. The truncated
           * version of this line is why the delimiter behaviour above went
           * undiagnosed the first time -- the token itself fell off the end
           * of the log. Titles are short; this costs nothing. */
          console.log(`[title-scrub] raw=${JSON.stringify(before)} -> ${JSON.stringify(after)}`);
        }
      }
    }
  } catch (e) { /* fail-soft: an ugly title beats a dead title call */ }
}

app.post('/chat/completions', async (req, res) => {
  const wantsStream = !!req.body.stream;
  const reqId = Math.random().toString(36).slice(2, 8);
  const msgCount = Array.isArray(req.body.messages) ? req.body.messages.length : 0;
  console.log(`[req ${reqId}] incoming model=${req.body.model} stream=${wantsStream} msgCount=${msgCount}`);
  const _toolNames = Array.isArray(req.body.tools) ? req.body.tools.map(t => (t.function && t.function.name) || t.name).filter(Boolean) : [];
  if (_toolNames.length) console.log(`[req ${reqId}] tools=[${_toolNames.join(',')}]`);
  req._reqId = reqId;

  // TOOL SHIM: translate tools -> prompt for models whose OR hosts reject the
  // tools param. No-op ({active:false}, same object path) for everything else.
  const shim = withToolShim(req.body);
  if (shim.active) console.log(`[req ${reqId}] TOOL SHIM active for ${req.body.model} (${_toolNames.length} tools -> prompt)`);

  if (wantsStream) {
    const upstreamBody = withReasoningIncluded(withProviderExclusion(appendReminder({ ...shim.body, stream: true })));
    // ask OpenRouter to include usage in the stream when possible
    upstreamBody.stream_options = { ...(upstreamBody.stream_options || {}), include_usage: true };
    // Deep-Think shim turns need the buffered path (their reply is one big
    // <think> block that becomes the reasoning bubble). Detect on the ORIGINAL
    // body -- withReasoningIncluded/withDeepThinkStripped removed the marker
    // from upstreamBody already.
    const shimDeepThink = shim.active && deepThinkRequested(req.body);
    return handleStreaming(req, res, upstreamBody, shim.active, shimDeepThink);
  }

  // -- non-streaming path: original buffered behaviour, now with the Novita
  // provider exclusion (see withProviderExclusion above) -----------------------
  let upstreamBody = withReasoningIncluded(withProviderExclusion(appendReminder({ ...shim.body, stream: false })));
  // Part 63: the router moved out of callOpenRouterOnce (see the comment
  // there). Non-stream person/room turns route here, same policy as the
  // streaming path at handleStreaming -- and now with a reqId in the logs.
  upstreamBody = await maybeAutoThink(upstreamBody, reqId);
  let result;
  try {
    result = await callOpenRouter(upstreamBody);
  } catch (err) {
    console.error('upstream chat/completions error:', err.message);
    const friendly = friendlyErrorBody(err.status, err.body || err.message);
    return res.status(err.status || 502).set('Content-Type', 'application/json').send(
      friendly || err.body || JSON.stringify({ error: { message: 'Upstream request failed' } })
    );
  }
  if (shim.active && parseShimToolCalls(result)) {
    // Shimmed tool-call turn: hand LibreChat the OpenAI shape untouched.
    return res.json(result);
  }
  await detectAndRewrite(result, upstreamBody);
  scrubSpecialTokensFromTitleReply(result, req.body);
  // Reverted same as the streaming path above -- do not embed reasoning into
  // message.content. See the long comment in handleStreaming() for why.
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`reframe-proxy listening on :${PORT}, level=${REFRAME_LEVEL}`);
});
