# The register edit (Oct 18 2026)

Kade, Oct 17 2026: "When I say essay, people and agents seem to automatically think I mean length,
but that's not what I meant. I don't mind length. What I care about is rigidity, like saying the
same thing in so many words just because it sounds nice on the page."

`register-edit.js` runs on the return path of every web character reply (after phrase repair,
before reply focus). MiMo Flash reads the finished reply and names the sentences shaped for the
page: restating the question, the knocked-down-idea reframe, set-up lines, quotable closers and
saying a point twice. For each one it writes how this character would say it out loud. Only those
spans change; every other byte stays.

## What was measured before shipping

68 of Kade's real turns (28 to Kiana, 8 each to Harley, Della, Earl, Nonna Maria and Denny), the
full production prompt rebuilt from the fork's own modules, the real gateway tail captured by
running this server offline, MiMo Pro on DeepInfra. Two blind judges in separate calls
(Claude Sonnet 5.5 and GPT-6.1 Sol), validated first on her real replies against plain rewrites.

| change | judged shapes per reply | character / talk |
|---|---|---|
| production prompt | 4.3 (Sonnet), 5.1 (Sol) | baseline |
| steady friend contract restated plainly | within noise | same |
| register-first final note | within noise | same |
| two voice samples per character | within noise | same |
| Kimi K3 / DeepSeek V4 Pro / MiniMax M3 | same or worse | same or lower |
| Claude Haiku 5.5 | fewer, by writing shorter | lower |
| **this editor, one pass (shipped)** | **about 25-30% fewer** | **held or rose** |
| this editor, two passes | no better with the guards, twice the time | same |

Live check after the deploy (48 probes before, 48 after, Kiana, Della, Earl, Nonna Maria, Denny,
Mrs. Witherspoon, the test seat, judged blind by Sol; different generations, so noisier than the
same-reply test): 4.5 -> 3.7 judged shapes per reply (2.2 -> 1.9 per 100 words). Reframes 0.56 ->
0.25, set-ups 1.44 -> 0.96, restates 0.62 -> 0.50; quotable closers and repeats unchanged.
Character 7.5 -> 7.5, talk 7.7 -> 7.8. Fewer for Kiana, Della, Nonna Maria and Mrs. Witherspoon;
Denny and Earl about even.

A separate meaning check (original vs edited) found most "losses" were the knocked-down half of
the reframes, which is the point; the guards below exist because unguarded runs also dropped
hedges, pet names and jokes.

## Guards

An edit is refused when it touches code, links or protected markup, changes a `%%%voice tag%%%`,
a number, a name, a pet name or a hedge (usually, maybe, I reckon...), deletes anything but
scaffolding, adds a laugh, or grows past its sentence. The whole result is refused if it cuts more
than 45% or loses a tag or number. Any failure, timeout or bad JSON keeps the reply as it was.

Skipped: replies under 280 or over 7,000 characters, code, JSON, and requests for writing where
the page shape is the point (essay, story, poem, letter, toast, rap, lyrics...).

## Speed

MiMo Flash speed swings by host and hour (03:38Z Oct 18: Io Net 10.3 s median, DeepInfra 3.7 s,
Makora 1.5 s; an hour earlier Io Net was the fast one). A pass asks Makora, then after 1.5 s also
Io Net, then DeepInfra; the first usable answer wins and the rest are cancelled. Measured: median
1.4 s, p90 4.1 s, cap 6 s per call and 9 s overall. Zero retention on every host.

## Switches (Railway, reframe-proxy)

- `KADE_REGISTER_EDIT=0` turns it off.
- `KADE_REGISTER_PASSES` (1 default, up to 3).
- `KADE_REGISTER_EDIT_MODEL` (default `xiaomi/mimo-v2.6-flash`), `KADE_REGISTER_EDIT_HOSTS`
  (default `Makora,Io Net,DeepInfra`), `KADE_REGISTER_EDIT_HEDGE_MS` (1500),
  `KADE_REGISTER_EDIT_TIMEOUT_MS` (6000), `KADE_REGISTER_EDIT_BUDGET_MS` (9000).

Log line: `[register-edit] {id,status,character,elapsedMs,chars,passes:[{status,ms,host,kinds,rejected}],usage}`.
`/health` (with the bearer) shows `registerEdit.counts`.

The voice writers (inworld `director.js`, `inworld-writer.js`) never change words, so they carry
whatever this leaves; they are not a source of the shapes.
