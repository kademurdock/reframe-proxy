# Follow-up relevance repair, September 8, 2026

The observed production failure was a high-confidence keep decision on a reply
that answered an older question instead of engaging the user's practical objection.
No private transcript is included here. The reviewer must distinguish a shared
subject from responding to what changed in the latest turn.

The revised prompt identifies the latest conversational move before deciding.
An acknowledgment followed by the old explanation is still a replay. Requested
elaboration and relevant callbacks are allowed. The same bounded reviewer and
character model remain; no extra review stage, model switch, history deletion,
persona edit, or automatic retry was added.

Review now runs after all prose cleanup. A verified character repair is delivered
without another utility rewrite that could change its relevance or voice.
Regeneration retains full original messages but no longer appends the defective
draft a second time. Its guidance allows a casual response to an objection rather
than automatically offering another plan. This guidance did not eliminate all
unnecessary advice in the model tests.

## Evidence

- `node --test *.test.js`: network-stubbed regression suite. The final-delivery
  tests fail on the old ordering. The HTTP test covers both streaming and buffered
  responses with runtime notes and a tool continuation; review sees the final
  polished draft, and verified character text reaches the client unchanged.
- Twelve invented reviewer cases: eight simple cases passed with both prompts.
  Four harder cases use a two-turn notebook discussion followed by either a
  convenience objection or a request to explain again. Both baseline runs missed
  two unwanted recaps and incorrectly rejected the requested explanation. The
  candidate classified all four correctly. The explicit-repeat runtime bypass
  can independently exempt the requested-explanation case; this reviewer-only
  result does not imply production would reject it.
- Two complete delivery-function probes used an intentionally supplied defective
  draft, the full live persona and invented history. The updated check rejected
  the draft, regenerated on Grok and accepted the replacement twice. An actual
  HTTP generation used the same invented history. These are controlled probes,
  not natural-user acceptance or a general error-rate estimate.
- Later repair-guidance probes still contained stock openings, conjecture and
  unnecessary advice. Do not label personality or factual reliability resolved.

Paid checks are opt-in and require a fresh user-approved ceiling; ordinary tests
never call a provider. Private session161 outputs retain the provider receipts
and full experimental inputs. Kill switch remains `KADE_REPLY_FOCUS=0`.

Existing limits remain: reviewer can be wrong/unavailable; one regeneration and
verification only; oversized input can skip; live phone/Clubhouse streaming is
outside the buffered guard. Saved history and memory are unchanged. No data
migration or backfill is needed.
