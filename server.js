/**
 * server.js — reframe-proxy
 *
 * Sits between LibreChat and OpenRouter as an OpenAI-compatible custom
 * endpoint. Two jobs, both aimed at the same list of AI-slop tics in
 * Kiana's Section 2 ("Never say these" + "Constructions to kill"):
 *
 * 1. REQUEST side: appends a short style reminder as the last message before
 *    forwarding to OpenRouter. A system prompt loaded once at the top of a
 *    long conversation loses grip by the time the model actually generates;
 *    putting a short copy of the rule physically adjacent to generation
 *    fixes that recency-decay problem (see appendReminder()).
 * 2. RESPONSE side: runs two deterministic detectors against the full reply
 *    — reframe-filter.js (the "it's not X, it's Y" shape, its own module
 *    because it's the most structurally involved) and slop-filter.js
 *    (the other four "constructions to kill" plus literal blocklist phrases
 *    from the seven "never say" lists). If anything trips, fires ONE
 *    targeted rewrite call back through the same model before handing the
 *    cleaned-up reply to LibreChat.
 *
 * Why buffer instead of true token streaming: detection has to run on the
 * FULL reply, so there is no way to inspect-and-maybe-rewrite mid-stream
 * without already having sent the bad text to the user. Every request —
 * streaming or not — is bought to completion against OpenRouter first. If
 * the caller asked for stream:true, the final (possibly rewritten) text is
 * sent back as a single-shot fake SSE stream so LibreChat's client code
 * still gets the shape it expects. This trades true incremental streaming
 * for correctness; Kiana already runs with disableStreaming:true so this
 * costs her nothing. A custom agent someone builds with streaming turned on
 * will notice replies arrive all at once rather than token-by-token —
 * known, accepted tradeoff for v1.
 *
 * Auth model: LibreChat is configured with a proxy-only shared secret as its
 * "apiKey" for this endpoint (NOT the real OpenRouter key — that lives only
 * here, as an env var). Anything hitting this service without that secret
 * gets a 401 before any OpenRouter credit is spent.
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

// -- model list passthrough (LibreChat's fetch:true calls this) --------------
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

// -- helpers -------------------------------------------------------------

async function callOpenRouter(body) {
  const upstream = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://kademurdock.com',
      'X-Title': 'Kade-AI',
    },
    body: JSON.stringify(body),
  });
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

// Human-readable rewrite guidance per pattern category, so the rewrite call
// gets told specifically what's wrong instead of a vague "fix the tone."
// Keys match the `pattern` field emitted by reframe-filter.js / slop-filter.js
// (blocklist categories are prefixed "blocklist:", matched by startsWith).
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

// -- request-side style reminder ------------------------------------------
//
// A system prompt loaded once at the top of a long conversation loses grip
// by the time the model is actually generating the next reply — recency
// decay. Appending a short copy of the rule as the LAST message before
// generation keeps it close to where it matters. This proxy receives a
// fresh `messages` array from LibreChat on every call (LibreChat resends
// full history based on what IT stored, and the injected reminder below is
// never part of what gets returned to/stored by LibreChat), so there's no
// risk of double-injecting across turns — each request gets exactly one
// reminder appended, fresh.
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

function sumUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return {
    prompt_tokens: (a.prompt_tokens || 0) + (b.prompt_tokens || 0),
    completion_tokens: (a.completion_tokens || 0) + (b.completion_tokens || 0),
    total_tokens: (a.total_tokens || 0) + (b.total_tokens || 0),
  };
}

function buildFakeSSE(finalResponse) {
  // Mimic an OpenAI-style streaming response with a single content delta,
  // then a finish chunk, then [DONE]. LibreChat's stream parser just wants
  // a sequence of `data: {...}\n\n` events shaped like chat.completion.chunk.
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

// -- main route ------------------------------------------------------------

app.post('/chat/completions', async (req, res) => {
  const wantsStream = !!req.body.stream;
  const upstreamBody = appendReminder({ ...req.body, stream: false });

  let result;
  try {
    result = await callOpenRouter(upstreamBody);
  } catch (err) {
    console.error('upstream chat/completions error:', err.message);
    return res.status(err.status || 502).set('Content-Type', 'application/json').send(
      err.body || JSON.stringify({ error: { message: 'Upstream request failed' } })
    );
  }

  const choice = result.choices?.[0];
  const content = choice?.message?.content;

  if (typeof content === 'string' && content.length > 0) {
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
        `[slop] tripped (${matches.length} match(es): ${matches
          .map((m) => m.pattern)
          .join(', ')}) — running rewrite pass`
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
  }

  if (wantsStream) {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    return res.send(buildFakeSSE(result));
  }

  res.json(result);
});

app.listen(PORT, () => {
  console.log(`reframe-proxy listening on :${PORT}, level=${REFRAME_LEVEL}`);
});
