# Part 162 — do not repeat these failed fixes blindly

Live code, persona280, memories and newest natural conversation were read first.
There was no post-Part161 natural conversation yet; the newest was 17:54 UTC.
Live reframe remained 84a79bb. All experiments used invented stationery, puzzle,
desk-organization and music conversations. Actual user conversations were neither
replayed nor edited. Kiana's full persona remained the baseline.

The notebook case contains two exchanges: curiosity about paper/supply preference,
an unwanted sketchbook suggestion, a clarification that the person is just
wondering, and repeated advice. The latest turn raises the convenience of the
corner-shop spiral notebook. Passing requires engaging that practical point,
without re-explaining the previous question or proposing another shopping/test
plan. Other fixtures check company without shopping, requested detailed help and
a substantive opinion. These are diagnostic cases, not a representative score.

## Results

- Removing the shared reminder's pressure to supply a concrete suggestion did
  not reliably stop old-question replay or unrequested advice.
- Adding explicit conversational-move guidance did not reliably help. Full local
  delivery-path tests also returned `kept` for bad drafts.
- Removing persona sentence/question quotas, mandatory extra contributions and
  example dialogue (57,246 -> 49,071 characters) did not fix the objection case.
  One requested-help sample reached the deliberately small 600-token probe cap;
  this is a truncated test output, not a production truncation regression.
- A more compact 21,787-character persona also failed. Neither persona shipped.
- Positive conversational examples about a concert/radio and rain did not fix it.
- A direct Grok low-reasoning call spent 1,160 reasoning tokens and still gave a
  shopping workaround with unsupported availability claims. No reasoning setting
  changed. An earlier local attempt was blocked before dispatch by the test size
  ceiling when production preparation expanded the reasoning token budget.
- Haiku4.5 as reviewer, with the current prompt, accepted the unwanted workaround
  and rejected a good conversational reaction. Do not switch reviewers on this
  evidence.
- Haiku4.5 as the main author with the unchanged full Kiana persona handled the
  initial objection probe better and retained requested help/opinion. But ONE
  full production-proxy probe on the related Part161 fixture again supplied an
  unwanted workaround. That is a failed broader-quality check, not recovery.

No prompt, persona, model, route, guard, memory or production setting changed.
The existing20 targeted regression tests passed before experiments. No paid Mac
build, speech synthesis, model backfill or user-account chat was created. This
branch contains this evidence note only; it is not a behavioral release.

The current review intentionally targets replay, not arbitrary unsolicited advice.
Do not infer that `kept` means good personality, grounded facts or user satisfaction.
Do not hide a failed live result behind four successful local examples. Continue
with a genuinely new hypothesis or a user-selected model comparison, plus broader
natural-use acceptance; do not add another prohibition and declare victory.
