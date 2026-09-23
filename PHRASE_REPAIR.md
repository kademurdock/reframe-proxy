# Local conversational wording edits

The response path uses exact span edits instead of regenerating a reply for style. Original character generation, performance directions and reply-focus handling are unchanged. The conversation guidance asks for direct spoken observations rather than commentary announcing an explanation's importance.

Existing actionable style detectors and three contextual families identify candidates: “that matters because,” “the part that/where,” and explanation announcements such as “the straight version.” These are candidates, not forbidden phrases.

1. Resolve flags to at most eight local passages, each no longer than 900 characters. Adjacent flagged sentences can share a passage; an unaffected sentence or paragraph breaks it.
2. When enabled, Jev 1.13.0 answers one batched probability question per passage. A probability at or below 0.15 spares the passage. Missing, malformed or uncertain scores go to the writer. A failed Jev request also leaves the bounded writer available.
3. A non-reasoning DeepSeek v4.1 Flash utility request can return up to twelve exact before/after edits, or none. It has a 12-second budget. The normal provider restrictions still apply.
4. Validate the entire edit set before applying it. Require unique source matches in allowed passages, no overlaps, unchanged numeric claims and protected content, bounded expansion, and a nonempty result retaining at least 45% of the draft. Trim unchanged prefixes/suffixes to their actual difference. Unaffected bytes are never regenerated.
5. When Jev is enabled, review the changed passages in one more batch. A probability of meaning loss at or above 0.8 rejects the proposal: facts, uncertainty, negation, feelings and opinions must survive. A missing/failed meaning review also preserves the original. Neither Jev call can write text; each has a 1.2-second budget.

Code, quotes, links, voice tags and markup are protected. Existing writing-desk, lyrics, keeper and machine exclusions remain, with an explicit structured-response exclusion. Replies over the existing 8,000-character limit retain their long-form bypass. Live phone streaming still has its existing passthrough; this is not an audio-engine or delivery-profile change.

Invalid edits, truncation, incoherence or a timeout retain the original. There is no second style call or whole-reply fallback on this path. Jev cannot propose wording or expand edit permissions. The writing model can keep a phrase even when Jev did not spare it. Ordinary uses and jokes must stay possible.

Configuration:

- `KADE_PHRASE_REPAIR=0`: restore the previous whole-reply style pass and omit the new detector families.
- `KADE_JEV_PHRASE_REPAIR=0`: keep local editing, without the Jev gates. Global `KADE_JEV=0` and a missing Typesafe key also disable them.
- `KADE_PHRASE_REPAIR_MODEL`: utility model override; default `deepseek/deepseek-v4.1-flash`. It does not change any character's model or persona.

`[phrase-repair]` logs decisions, counts, model-specific usage and Jev probabilities without logging the draft or edited passages. Utility costs are separate from original-model token billing. `/slop-stats` distinguishes local edits, contextual keeps and failures. Counters reset on deploy.

Offline checks: run `node --test phrase-repair.test.js phrase-judge.test.js phrase-repair-wire.test.js rewrite-wire.test.js reply-focus-wire.test.js slopstats.test.js`. These use mock writers and make no paid calls. Real model judgments still require reviewed samples; a syntactically valid patch is not proof that its semantics are perfect.
