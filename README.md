# reframe-proxy

OpenAI-compatible proxy that sits between LibreChat and OpenRouter, built to
kill the AI-slop tics in Kiana's system prompt. Two layers:

- **Request side**: appends a short style reminder as the last message right
  before forwarding to OpenRouter, so the rule sits close to where generation
  actually happens instead of decaying over a long conversation (see
  `appendReminder()` in `server.js`).
- **Response side**: runs two deterministic detectors against the full reply
  — `reframe-filter.js` (the "it's not X, it's Y" shape) and `slop-filter.js`
  (literal blocklist phrases from the "never say" lists, plus the other four
  "constructions to kill": rhetorical Q&A combos, stacked one-word fragments,
  stacked hedge words, em-dash-into-list restatements). No LLM judge, just
  regex/substring matching. If anything trips, fires one targeted rewrite
  pass through the same model, naming the specific tics found, before handing
  the reply back to LibreChat.

`slop-filter.js`'s blocklist is deliberately tuned toward precision over
recall — multi-word distinctive phrasing only, not bare common words like
"journey" or "navigate" — so normal conversation doesn't get over-triggered
into constant rewrite calls.

## Env vars (set on Railway, never committed)

- `OPENROUTER_KEY` — the real OpenRouter API key. Only this service holds it;
  LibreChat is configured with a separate shared secret instead.
- `PROXY_SHARED_SECRET` — bearer token LibreChat must send. Anything without
  it gets 401'd before any OpenRouter credit is spent.
- `REFRAME_LEVEL` — optional, `strict` | `balanced` (default) | `aggressive`.
  See the detector's own comments for the false-positive tradeoffs of each.
- `PORT` — optional, Railway sets this automatically.

## Routes

- `GET /health` — no auth required, used by Railway's healthcheck.
- `GET /models` — passthrough to OpenRouter's model list (LibreChat's
  `fetch: true` model picker hits this).
- `POST /chat/completions` — main route. Always buffers the full OpenRouter
  reply (even if the caller asked for `stream: true`) so the detector can see
  the whole message before deciding whether to rewrite. If `stream: true` was
  requested, the final text is sent back as a single-shot fake SSE stream
  (one content delta + a finish chunk 