# reframe-proxy

OpenAI-compatible proxy that sits between LibreChat and OpenRouter. Detects the
"it's not X, it's Y" rhetorical reframe tic in model replies (via
`reframe-filter.js`, a deterministic regex detector, no LLM judge) and, if it
trips, runs one targeted rewrite pass through the same model before handing
the reply back to LibreChat.

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
  (one content delta + a finish chunk + `[DONE]`) so LibreChat's client still
  gets the shape it expects — just not real token-by-token streaming. Kiana
  runs with `disableStreaming: true` already, so this costs her nothing; any
  other agent built with streaming on will notice replies land all at once.

## Local testing

```
npm install
OPENROUTER_KEY=sk-or-... PROXY_SHARED_SECRET=test123 node server.js
curl -H "Authorization: Bearer test123" -H "Content-Type: application/json" \
  -d '{"model":"z-ai/glm-5.2","messages":[{"role":"user","content":"hi"}]}' \
  http://localhost:8080/chat/completions
```

`node --check server.js` and `node reframe-filter.js` (runs the detector's own
test suite) are both safe to run with no network/env vars.

## Deploy

Same pattern as `kademurdock/inworld-tts-proxy`: push to `main`, Railway
auto-deploys (service is wired with a GitHub auto-deploy trigger). Check
`/health` after any push.
