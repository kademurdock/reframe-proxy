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
const { detect } = require('./reframe-filter');
const { detectSlop } = require('./slop-filter');

const PORT = process.env.PORT || 8080;
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const PROXY_SHARED_SECRET = process.env.PROXY_SHARED_SECRET;
const REFRAME_LEVEL = process.env.REFRAME_LEVEL || 'balanced';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

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

function openRouterHeaders() {
  return {
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    'Content-Type': 'application/json',
    'HTTP-Referer': 'https://kademurdock.com',
    'X-Title': 'Kade-AI',
  };
}

async function callOpenRouterOnce(body, timeoutMs) {
  const upstream = await fetchWithTimeout(
    `${OPENROUTER_BASE}/chat/completions`,
    { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(body) },
    timeoutMs
  );
  const text = await upstream.text();
  if (!upstream.ok) {
    const err = new Error(`OpenRouter ${upstream.status}: ${text.slice(0, 500)}`);
    err.status = upstream.status;
    err.body = text;
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

async function callOpenRouter(body, timeoutMs = REQUEST_TIMEOUT_MS) {
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
};

function guidanceFor(patternName) {
  if (PATTERN_GUIDANCE[patternName]) return PATTERN_GUIDANCE[patternName];
  if (patternName.startsWith('blocklist:')) return 'generic AI-slop phrasing';
  return patternName.replace(/_/g, ' ');
}

function buildRewriteSystemPrompt(matches) {
  const categories = [...new Set(matches.map((m) => guidanceFor(m.pattern)))];
  const list = categories.map((c) => `- ${c}`).join('\n');
  return [
    'You will be given a passage of text written by an AI assistant. The passage',
    'overuses one or more known AI-writing tics, specifically:',
    list,
    '',
    'Rewrite the passage so it says the same thing, with the same facts, tone,',
    'and length, WITHOUT any of those tics anywhere. Do not introduce new claims.',
    'Do not add commentary, a preamble, or quotation marks around your answer.',
    'Output ONLY the rewritten passage, nothing else.',
  ].join('\n');
}

async function rewritePass(originalBody, offendingText, matches) {
  const rewriteBody = {
    model: originalBody.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: buildRewriteSystemPrompt(matches) },
      { role: 'user', content: offendingText },
    ],
  };
  const result = await callOpenRouter(rewriteBody);
  const text = result?.choices?.[0]?.message?.content;
  return { text: text ? text.trim() : null, usage: result?.usage || null };
}

// -- request-side style reminder ---------------------------------------------
const STYLE_REMINDER = [
  'Quick style check before you answer: no "it\'s not X, it\'s Y" reframes, no',
  'stacked rhetorical questions answered in one word, no strings of one-word',
  'fragment sentences for emphasis, no stacked hedge words, no em-dash-into-',
  'dramatic-list restatements. Skip therapy-bot validation ("that takes',
  'courage"), filler transitions ("at the end of the day"), consultant-speak',
  '("let\'s dive in," "leverage," "circle back"), and essay-bot phrasing',
  '("tapestry," "testament to"). Just talk like Kiana actually talks.',
].join(' ');

function appendReminder(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;
  return {
    ...body,
    messages: [...body.messages, { role: 'system', content: STYLE_REMINDER }],
  };
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

// Run detectors on a fully-buffered assistant `content` string and, if any
// tic trips, perform the rewrite pass. Mutates and returns `result`.
async function detectAndRewrite(result, upstreamBody) {
  const choice = result.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) return result;

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

  if (matches.length > 0) {
    console.log(
      `[slop] tripped (${matches.length} match(es): ${matches.map((m) => m.pattern).join(', ')}) — running rewrite pass`
    );
    try {
      const rewritten = await rewritePass(upstreamBody, content, matches);
      if (rewritten.text) {
        result.choices[0].message.content = rewritten.text;
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
  const chunk1 = {
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
function withReasoningIncluded(body) {
  const existing = body.reasoning || {};
  // Phone calls are marked by the kade-ai-bridge PHONE_SUFFIX ("[PHONE CALL ...")
  // in the last user message. For those, force reasoning effort LOW to cut the
  // pre-speech wait on long replies (~halves it) — applies to EVERY agent on the
  // phone. Web traffic carries no marker, so its path is byte-identical to before.
  let isPhone = false;
  try {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') {
        const c = msgs[i].content;
        isPhone = typeof c === 'string' && c.includes('[PHONE CALL');
        break;
      }
    }
  } catch { isPhone = false; }
  const reasoning = isPhone
    ? { ...existing, effort: 'low', exclude: false }
    : { ...existing, exclude: false };
  return { ...body, reasoning };
}

// -- streaming handler -------------------------------------------------------
// Reads OpenRouter's SSE stream. Buffers raw events until it can tell whether
// this is a TOOL-CALL turn (-> flip to live passthrough) or a pure CONTENT
// turn (-> buffer to end, detect/rewrite, emit fake SSE). Inactivity timeout
// guards against a stalled upstream provider mid-stream.
const STREAM_IDLE_TIMEOUT_MS = 90_000;

async function handleStreaming(req, res, upstreamBody) {
  const reqId = req._reqId || '??????';
  const t0 = Date.now();
  console.log(`[req ${reqId}] handleStreaming start, reasoning=${JSON.stringify(upstreamBody.reasoning)}`);
  let upstream;
  try {
    upstream = await fetchWithTimeout(
      `${OPENROUTER_BASE}/chat/completions`,
      { method: 'POST', headers: openRouterHeaders(), body: JSON.stringify(upstreamBody) },
      STREAM_IDLE_TIMEOUT_MS
    );
  } catch (err) {
    const status = err.name === 'AbortError' ? 504 : 502;
    console.error(`[req ${reqId}] initial fetch failed after ${Date.now() - t0}ms: ${err.name} ${err.message}`);
    return res.status(status).set('Content-Type', 'application/json').send(
      JSON.stringify({ error: { message: 'Upstream request failed', type: 'upstream_error' } })
    );
  }
  console.log(`[req ${reqId}] upstream headers received after ${Date.now() - t0}ms, status=${upstream.status}, content-type=${upstream.headers.get('content-type')}`);

  if (!upstream.ok) {
    const text = await upstream.text();
    console.error(`[req ${reqId}] upstream not ok: ${upstream.status} ${text.slice(0,300)}`);
    return res.status(upstream.status).set('Content-Type', 'application/json').send(text);
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
    await detectAndRewrite(json, upstreamBody);
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
  let template = null; // first parsed chunk, reused to shape the fake SSE on content turns
  let finishReason = 'stop';
  let usage = null;

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
          if (data === '[DONE]') continue;
          let chunk;
          try {
            chunk = JSON.parse(data);
          } catch (e) {
            continue;
          }
          if (!template) template = chunk;
          if (chunk.usage) usage = chunk.usage;
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
            // Accumulate reasoning for end-of-turn <think> injection (see
            // below). Do NOT forward raw delta.reasoning chunks live — the
            // ON_REASONING_DELTA path in @librechat/agents dispatched events
            // but the browser stepMap lookup returned null so no bubble
            // appeared. Instead, keep the connection alive by forwarding a
            // structurally identical chunk with an empty delta.content (so
            // LibreChat's LLM client sees a continuous stream and never times
            // out), but strip delta.reasoning so the streaming handler treats
            // it as an innocuous keep-alive. The full reasoning is injected as
            // <think>...</think> at the head of the synthetic content chunk
            // after the read loop; see the block below for details.
            reasoningAccum += reasoningText;
            const heartbeat = {
              id: chunk.id,
              object: chunk.object || 'chat.completion.chunk',
              created: chunk.created,
              model: chunk.model,
              choices: [{ index: 0, delta: { content: '' }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
            handledLive = true;
          }
          if (typeof delta.content === 'string') contentAccum += delta.content;
        }
        if (toolMode) break;
        if (!handledLive) {
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

  if (toolMode) {
    // live passthrough already wrote everything incl. upstream's [DONE]
    console.log(`[req ${reqId}] tool-mode response ended at ${Date.now() - t0}ms`);
    try { res.end(); } catch (e) {}
    return;
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
  if (reasoningAccum.length > 0 && result.choices[0].message.content.length > 0) {
    const seed = {
      id: result.id,
      object: 'chat.completion.chunk',
      created: result.created,
      model: result.model,
      choices: [{ index: 0, delta: { reasoning: '\u200B', content: '' }, finish_reason: null }],
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
app.post('/chat/completions', async (req, res) => {
  const wantsStream = !!req.body.stream;
  const reqId = Math.random().toString(36).slice(2, 8);
  const msgCount = Array.isArray(req.body.messages) ? req.body.messages.length : 0;
  console.log(`[req ${reqId}] incoming model=${req.body.model} stream=${wantsStream} msgCount=${msgCount}`);
  req._reqId = reqId;

  if (wantsStream) {
    const upstreamBody = withReasoningIncluded(withProviderExclusion(appendReminder({ ...req.body, stream: true })));
    // ask OpenRouter to include usage in the stream when possible
    upstreamBody.stream_options = { ...(upstreamBody.stream_options || {}), include_usage: true };
    return handleStreaming(req, res, upstreamBody);
  }

  // -- non-streaming path: original buffered behaviour, now with the Novita
  // provider exclusion (see withProviderExclusion above) -----------------------
  const upstreamBody = withReasoningIncluded(withProviderExclusion(appendReminder({ ...req.body, stream: false })));
  let result;
  try {
    result = await callOpenRouter(upstreamBody);
  } catch (err) {
    console.error('upstream chat/completions error:', err.message);
    return res.status(err.status || 502).set('Content-Type', 'application/json').send(
      err.body || JSON.stringify({ error: { message: 'Upstream request failed' } })
    );
  }
  await detectAndRewrite(result, upstreamBody);
  // Reverted same as the streaming path above -- do not embed reasoning into
  // message.content. See the long comment in handleStreaming() for why.
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`reframe-proxy listening on :${PORT}, level=${REFRAME_LEVEL}`);
});
