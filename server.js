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
function chatCompletionsUrl(model) {
  return isKimiModel(model) ? `${MOONSHOT_BASE}/chat/completions` : `${OPENROUTER_BASE}/chat/completions`;
}
function chatHeaders(model) {
  if (isKimiModel(model)) {
    return { Authorization: `Bearer ${MOONSHOT_KEY}`, 'Content-Type': 'application/json' };
  }
  return openRouterHeaders();
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
  if (wantsReasoning) {
    next.temperature = 1;
    const mt = Number(next.max_tokens);
    next.max_tokens = Number.isFinite(mt) ? Math.max(mt, 3000) : 3000;
  } else {
    next.reasoning_effort = 'none';
    next.temperature = 0.6;
  }
  return next;
}

async function callOpenRouterOnce(body, timeoutMs) {
  body = adaptForKimi(body);
  const upstream = await fetchWithTimeout(
    chatCompletionsUrl(body.model),
    { method: 'POST', headers: chatHeaders(body.model), body: JSON.stringify(body) },
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

async function rewritePass(originalBody, offendingText, matches, hasProtectedTags = false) {
  const rewriteBody = {
    model: originalBody.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: buildRewriteSystemPrompt(matches, hasProtectedTags) },
      { role: 'user', content: offendingText },
    ],
  };
  const result = await callOpenRouter(rewriteBody);
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
  '("tapestry," "testament to"). Just talk the way your own character',
  'naturally talks. Platform note: if anyone asks how to reach you or this',
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

function appendReminder(body) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) return body;
  const toolNotes = toolNotesFor(body);
  return {
    ...body,
    messages: [...body.messages, { role: 'system', content: STYLE_REMINDER + MONEY_NOTE + currentTimeNote() + toolNotes }],
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
function normalizeVoiceTagTypos(text) {
  if (!text || text.indexOf('%%') === -1) return text;
  return text.replace(/%{2,4}([a-zA-Z][a-zA-Z ’',!-]{0,60}?)%{2,4}/g, '%%%$1%%%');
}

async function detectAndRewrite(result, upstreamBody) {
  const choice = result.choices?.[0];
  let content = choice?.message?.content;
  if (typeof content !== 'string' || content.length === 0) return result;
  // Normalize voice-tag typos first so protection/rewrite and every consumer
  // downstream (fork stripper, TTS steering) see only the canonical %%% form.
  const normalized = normalizeVoiceTagTypos(content);
  if (normalized !== content) {
    console.log('[voice-tags] normalized malformed %%-tag(s) in reply');
    content = normalized;
    choice.message.content = normalized;
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
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!msgs[i] || msgs[i].role !== 'user') continue;
      const text = messageTextOf(msgs[i].content);
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
  const isDeep = deepThinkRequested(body);
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
  upstreamBody = adaptForKimi(upstreamBody);
  let upstream;
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
  console.log(`[req ${reqId}] upstream headers received after ${Date.now() - t0}ms, status=${upstream.status}, content-type=${upstream.headers.get('content-type')}`);

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
            const heartbeat = {
              id: chunk.id,
              object: chunk.object || 'chat.completion.chunk',
              created: chunk.created,
              model: chunk.model,
              choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
            };
            res.write(`data: ${JSON.stringify(heartbeat)}\n\n`);
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
          res.write(rawEvent + '\n\n');
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
  if (reasoningAccum.length > 0 && result.choices[0].message.content.length > 0) {
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
  const upstreamBody = withReasoningIncluded(withProviderExclusion(appendReminder({ ...shim.body, stream: false })));
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
  // Reverted same as the streaming path above -- do not embed reasoning into
  // message.content. See the long comment in handleStreaming() for why.
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`reframe-proxy listening on :${PORT}, level=${REFRAME_LEVEL}`);
});
