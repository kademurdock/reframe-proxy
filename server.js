/**
 * server.js — reframe-proxy
 *
 * Sits between LibreChat and OpenRouter as an OpenAI-compatible custom
 * endpoint. Forwards every chat completion to OpenRouter, then runs the
 * deterministic reframe-filter.js detector against the assistant's reply.
 * If the "it's not X, it's Y" rhetorical tic trips, fires ONE targeted
 * rewrite call back through the same model asking it to say the same thing
 * without the tic, then hands the cleaned-up reply back to LibreChat.
 *
 * Why buffer instead of true token streaming: detection has to run on the
 * FULL reply (the tic spans a whole sentence/pair of clauses), so there is
 * no way to inspect-and-maybe-rewrite mid-stream without already having sent
 * the bad text to the user. Every request — streaming or not — is bought to
 * completion against OpenRouter first. If the caller asked for stream:true,
 * the final (possibly rewritten) text is sent back as a single-shot fake SSE
 * stream so LibreChat's client code still gets the shape it expects. This
 * trades true incremental streaming for correctness; Kiana already runs with
 * disableStreaming:true so this costs her nothing. A custom agent someone
 * builds with streaming turned on will notice replies arrive all at once
 * rather than token-by-token — known, accepted tradeoff for v1.
 *
 * Auth model: LibreChat is configured with a proxy-only shared secret as its
 * "apiKey" for this endpoint (NOT the real OpenRouter key — that lives only
 * here, as an env var). Anything hitting this service without that secret
 * gets a 401 before any OpenRouter credit is spent.
 */

'use strict';

const express = require('express');
const { detect } = require('./reframe-filter');

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

const REWRITE_SYSTEM_PROMPT = [
  'You will be given a passage of text written by an AI assistant. The passage',
  'overuses the rhetorical device "It\'s not X, it\'s Y" (or close variants like',
  '"isn\'t just X, it\'s Y" / "not X but Y"). Rewrite the passage so it says the',
  'same thing, with the same facts, tone, and length, WITHOUT that rhetorical',
  'reframe pattern anywhere. Do not introduce new claims. Do not add commentary,',
  'a preamble, or quotation marks around your answer. Output ONLY the rewritten',
  'passage, nothing else.',
].join(' ');

async function rewritePass(originalBody, offendingText) {
  const rewriteBody = {
    model: originalBody.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: REWRITE_SYSTEM_PROMPT },
      { role: 'user', content: offendingText },
    ],
  };
  const result = await callOpenRouter(rewriteBody);
  const text = result?.choices?.[0]?.message?.content;
  return { text: text ? text.trim() : null, usage: result?.usage || null };
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
  const upstreamBody = { ...req.body, stream: false };

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
    let detection;
    try {
      detection = detect(content, { level: REFRAME_LEVEL });
    } catch (err) {
      console.error('detect() threw, skipping rewrite pass:', err.message);
      detection = { tripped: false };
    }

    if (detection.tripped) {
      console.log(
        `[reframe] tripped (${detection.matches.length} match(es): ${detection.matches
          .map((m) => m.pattern)
          .join(', ')}) — running rewrite pass`
      );
      try {
        const rewritten = await rewritePass(upstreamBody, content);
        if (rewritten.text) {
          result.choices[0].message.content = rewritten.text;
          result.usage = sumUsage(result.usage, rewritten.usage);
        } else {
          console.warn('[reframe] rewrite pass returned no text, keeping original');
        }
      } catch (err) {
        console.error('[reframe] rewrite pass failed, keeping original reply:', err.message);
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
