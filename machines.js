'use strict';
/**
 * THE PROACTIVE SWEEP the record kept demanding (HOW_TO_VERIFY law 19:
 * "carve a new machine lane out of appendReminder on the day it ships, not
 * the week it fails"). Part 112, Aug 31 2026 — the first time anybody went
 * LOOKING instead of waiting for a lane to die.
 *
 * The sweep, in full, so the next session does not redo it. Every fork lane
 * that calls a model through this proxy, and what appendReminder does to it:
 *
 *   1. TITLER (addTitle)              — title-shaped (no system, no tools): SKIPPED. ✅
 *   2. CHECKPOINT WRITER (compaction) — compaction.js carve-out: clock only. ✅
 *   3. MEMORY KEEPER (processMemory)  — keeper.js carve-out (toolbelt): NOTHING. ✅
 *      ...and the keeper carve-out ALSO covers every lane that reuses
 *      processMemory with the keeper toolbelt: the history miner, the GPT
 *      import, the call memory write, and consolidateV2 — all detected by
 *      set_memory/log_diary on the belt, whoever the caller is. ✅
 *   4. RELATIONSHIP SUMMARY (kadeMemorySummary.js) — system message, tools:[]
 *      — NEITHER title-shaped NOR keeper-shaped, so it has been collecting
 *      the FULL ~3KB style reminder on every nightly refresh since the
 *      reminder was born. Its output is STORED and read back into personas.
 *      Carved out HERE. ⚠️ was exposed
 *   5. DIARY VOICE REPAIR (diaryVoiceRepair.js) — same shape (system,
 *      tools:[]), a retrofit lane that rewrites logbook wording. Same
 *      exposure, same carve-out. ⚠️ was exposed
 *
 * Bridge lanes (research desk, errands planner, phone/call brains) call
 * Moonshot/OpenRouter DIRECT, never through this proxy — out of scope by
 * construction, listed so nobody re-sweeps them.
 *
 * Detection is anchored to machine-typed wording in the FINAL message —
 * the compaction.js doctrine: a person cannot accidentally type these, and
 * a conversation that merely QUOTES them does not end on them.
 *
 * These lanes build their own date lines (both prompts carry the DATE LAW
 * internally), so they get NOTHING appended — not even the clock.
 *
 * Kill switch: KADE_MACHINE_CARVEOUTS=0 restores the old behaviour.
 */

const { finalMessageText } = require('./compaction.js');

/* kadeMemorySummary.js's userContent ends with exactly this sentence, after
 * a "PREVIOUS SUMMARY (may be empty):" block no person types. */
const SUMMARY_TAIL_RE = /Write the updated running summary now\.\s*$/;
const SUMMARY_BLOCK_RE = /PREVIOUS SUMMARY \(may be empty\):/;

/* PART 113 (Sep 1 2026) — THE PERSONA WRITER, carved out ON THE DAY IT SHIPS
 * (law 19, for the first time proactively rather than after a post-mortem).
 * kadeCreateCharacter.js's `write-persona` route asks a model to WRITE a
 * character's system prompt. If it received STYLE_REMINDER, the reminder is
 * the last thing in the context and the model would dutifully write the
 * platform's own anti-slop text INTO the persona -- every character created
 * on this platform would arrive carrying a copy of it as its personality,
 * fighting the real copy that arrives globally on every turn. The anti-slop
 * rules already reach that character from this proxy at runtime; they must
 * not also be baked into the artifact.
 * The route's user message opens with a block no person types and ends with
 * exactly this sentence. */
const PERSONA_TAIL_RE = /Write the character's system prompt now\.\s*$/;
const PERSONA_BLOCK_RE = /CHARACTER BRIEF \(from the person building them\):/;

/* diaryVoiceRepair.js's batches end with exactly this sentence, after a
 * numbered "Entries:" block. */
const REPAIR_TAIL_RE = /Review them per your instructions\.\s*$/;
const REPAIR_BLOCK_RE = /Entries:\s*\n/;

function isMemorySummaryShapedBody(body) {
  const text = finalMessageText(body);
  return SUMMARY_TAIL_RE.test(text) && SUMMARY_BLOCK_RE.test(text);
}

function isDiaryRepairShapedBody(body) {
  const text = finalMessageText(body);
  return REPAIR_TAIL_RE.test(text) && REPAIR_BLOCK_RE.test(text);
}

function isPersonaWriterShapedBody(body) {
  const text = finalMessageText(body);
  return PERSONA_TAIL_RE.test(text) && PERSONA_BLOCK_RE.test(text);
}

function isSweptMachineBody(body) {
  if (process.env.KADE_MACHINE_CARVEOUTS === '0') return false;
  return (
    isMemorySummaryShapedBody(body) ||
    isDiaryRepairShapedBody(body) ||
    isPersonaWriterShapedBody(body)
  );
}

module.exports = {
  isMemorySummaryShapedBody,
  isDiaryRepairShapedBody,
  isPersonaWriterShapedBody,
  isSweptMachineBody,
};
