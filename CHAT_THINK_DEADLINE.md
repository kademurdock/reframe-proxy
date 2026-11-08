# Chat think deadline

Added Nov 8 2026. Everything here is **off by default**. With none of the variables below set, every request runs exactly as it did on 2fda653.

## What it does

MiMo chat turns have no time limit on their thinking. The Sound Booth's think deadline (`kade_think_deadline_ms`, Oct 27) only applies when a caller sends it. This change lets the gateway set the same deadline on chat turns by itself.

- `maybeAutoThink` now reports what it decided (`instant`, `quick`, `deep`, or `explicit` when a caller already chose an effort). `handleStreaming` uses that to arm `req._thinkDeadlineMs`.
- A deadline is armed only when all of these hold:
  - the turn will think,
  - on a MiMo model,
  - on the screen lane (not a phone call, not the tool shim),
  - and the caller sent no `kade_think_deadline_ms`. A caller's own value always stands, even an unusable one.
- A thought cut at the deadline is rescued on its own **chat lane** (`modelbudget.rescueChatThought`), not with the booth's song wording:
  - **Short thought** (under 400 characters): this is a host stall. There is no plan, just one plain write with thinking off.
  - **Plan:** made on MiMo Flash with `models` deleted, the Flash host order, 250 tokens, a 10 s window and thinking off. Zero retention and data-collection deny are kept.
  - **Writer:** the turn's own model, thinking off, a 60 s window, capped at 4,000 tokens. It sees **only the plan**, never the raw thought.
  - **Tool calls:** if the writer answers with `tool_calls`, that message goes to the client intact. The rescue never serves an empty turn.
  - **Fallback:** if the plan or the writer fails, comes back empty, runs to its cap or dies mid-reply (`finish=error`), there is one plain thinking-off write. If that fails too, the turn takes the existing path.
  - **No re-ask with thinking on:** a rescued chat turn never goes to the truncation retry (`KADE_RETRY_TRUNCATED`), which would resend the original body with thinking on and no limit. A writer that died mid-reply is served with `finish_reason: length`.

## Switches

| Variable | Default | Effect |
|---|---|---|
| `KADE_CHAT_THINK_DEADLINE` | unset (off) | `1` arms the deadline. Any other value is off. |
| `KADE_CHAT_THINK_DEADLINE_QUICK_MS` | 20000 | A quick vote that thinks |
| `KADE_CHAT_THINK_DEADLINE_DEEP_MS` | 45000 | A deep vote |
| `KADE_CHAT_THINK_DEADLINE_EXPLICIT_MS` | 75000 | The Deep button, a character's effort setting, or anything else that thinks |
| `KADE_CHAT_THINK_DEADLINE_TOOLSTEP_MS` | 15000 | An agent step whose last message is a tool result |
| `KADE_MIMO_QUICK` | unset | Unset: quick rides instant. `low`: quick thinks at low with no limit. **`deadline`**: quick thinks at low **and always gets the quick limit, even with the master switch off**. Only where the limit can arm: on a call turn, a shim turn, the non-stream route, or behind a caller's unusable `kade_think_deadline_ms`, quick rides instant as if unset. |

All values in ms are clamped to the range 5 s to 30 min.

## Rollback

- To turn it all off: unset `KADE_CHAT_THINK_DEADLINE`, and set `KADE_MIMO_QUICK` back to unset (or `low`). Nothing is armed after that, so the chat rescue never runs. No deploy is needed beyond the variable change.
- `KADE_THINK_DEADLINE=0`, the booth's switch, still governs only the caller's field. It does not disarm the chat deadline.

## Logs

- `[chat-think][req X] armed <ms> tier=<quick|deep|explicit|toolstep>`
- `[auto-think][req X] MiMo: quick thinks at effort low under a time limit (KADE_MIMO_QUICK=deadline)`
- `[auto-think][req X] MiMo: quick ridden as instant (KADE_MIMO_QUICK=deadline, but no time limit can arm on this turn)`
- `THINK DEADLINE: <ms>ms and no words yet ...` (the existing cut line)
- `[chat-think][req X] rescue path: plan then write` / `plain write (a N-char thought is a host stall, no plan)` / `plain write (fallback...)`
- `[chat-think][req X] rescue: made a N-char plan from M chars of thought` / `plan failed (...)` / `write from the plan came back empty`
- `[chat-think][req X] landed N chars via <path>` / `landed K tool call(s) via <path>`
- `[req X] chat-think rescue tool turn sent at <ms>ms (K call(s))`

## The words it adds (for Kade's review)

All three strings are in `modelbudget.js`. Only `CHAT_PLAN_MESSAGE` reaches the character's model. It is added as the last user message, and only on a cut turn:

```
Notes for your reply: {plan}

Answer the last message now, in your own voice. Don't mention these notes.
```

The plan call on Flash uses `CHAT_PLAN_SYSTEM` and `CHAT_NOTES_MESSAGE`. These are never seen by the character.

## Known gaps

- **Non-stream turns:** the deadline is honoured on the streaming screen lane only. Under `KADE_MIMO_QUICK=deadline` a non-stream quick vote rides instant (it cannot be limited), and `KADE_CHAT_THINK_DEADLINE=1` arms nothing there.
- **Usage metering:** a cut turn's rescue calls (plan and writer) are not added to `usage`. This is the same as the booth rescue.
- **Agent steps:** each agent step is voted and limited on its own. A three-step tool turn can take up to three limits plus their rescues.
- **The reasoning bubble:** it shows the thought up to the cut. On the chat lane the gateway keeps the ordinary bubble. The booth's "no `<think>` in the content" rule stays booth-only.
