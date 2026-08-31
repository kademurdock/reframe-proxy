'use strict';
/**
 * THE KEEPER LANE — the fourth time the style reminder ate a machine lane.
 *
 * PART 107, Aug 31 2026. The logbook died on Aug 24 2026 and stayed dead.
 * Part 106 (Aug 26) convicted the MODEL: same instructions, same exchange,
 * three runs each, `deepseek-v4-flash` logged the rabbit hole 3/3 and
 * `glm-4.5-air` managed 1/3. The fix shipped was a prompt hoist. It measured
 * 3/3 afterwards and the logbook did not come back.
 *
 * ⚠️ THAT MEASUREMENT WENT THROUGH THE WRONG DOOR. It called the model
 * directly. Production calls it through THIS proxy. Re-run Aug 31, same
 * keeper instructions, same tool schemas, same probe, single variable:
 *
 *   glm-4.5-air, Z.AI direct, thinking disabled ............. log_diary 8/8
 *   glm-4.5-air, same call + this proxy's style reminder .... log_diary 0/8
 *   glm-4.5-air, THROUGH THE LIVE PROXY, n=12 .............. log_diary 0/12
 *
 * The model was never the problem. `appendReminder` was.
 *
 * WHY IT REACHES THE KEEPER. The memory keeper carries a system message AND
 * tools, so it is neither title-shaped nor compaction-shaped, and it collects
 * the whole appended tail: STYLE_REMINDER, the format note, the money note,
 * the lane note, the drift steer, the voice anchors, the clock, the tool
 * notes. About 3KB of instruction on HOW TO TALK TO A PERSON, appended as the
 * LAST message — the most salient position in the request — to a call whose
 * entire job is to decide whether to fire `log_diary`. Told to "give a real
 * opinion or a concrete suggestion instead", a small model writes a reply.
 * The proxy's own logs show it: finish_reason `stop`, prose in `content`, no
 * tool call at all.
 *
 * AND THE DATES LINE UP EXACTLY. Logbook entries per day, counted across
 * three seats: Aug 17: 43 · Aug 18: 46 · Aug 19: 47 · Aug 20: 17 · Aug 21: 7
 * · Aug 22: 3 · Aug 23: 2 · Aug 24 on: 0. The cliff is Aug 20, the morning
 * after `f81f36e9` grew the style reminder ("stop the parrot opening, the
 * unsolicited character analysis") and the day `379277ec` merged the cadence
 * drift steer into it. Aug 21 added voice anchors (`0451ba74`), the format
 * line (`90014abf`) and the tool notes (`e9f6e985`) — and the count fell to
 * 7. The note grew; the logbook shrank; the model switch that got the blame
 * happened on Aug 21, a day AFTER the decline started.
 *
 * THE SAME BUG, FOURTH TIME. `d4c7953f` (Aug 18): "the style reminder was
 * breaking the titler (ROOT CAUSE, THIRD TIME)". `c7c4fc91` (Aug 23): the
 * checkpoint writer, same mechanism, fixed in compaction.js — whose comment
 * already says the whole lesson out loud: *extra prose in a machine lane ends
 * up IN the output*. Three machine lanes were carved out one at a time. The
 * keeper is the fourth, and nobody had gone looking for it because the card
 * half of memory kept working and hid the failure.
 *
 * A KEEPER IS MACHINERY. It gets nothing appended — not even the clock: the
 * fork builds it its own `centralNowLine()` inside the memory status block
 * (packages/api/src/agents/memory.ts, processMemory).
 *
 * DETECTION IS ON THE TOOLBELT, NOT ON PROSE. `set_memory`, `delete_memory`
 * and `log_diary` are created only in the memory lane and are never attached
 * to an agent — the agent-facing memory tool is `kade_memory_search`, a
 * different name. So "every tool in this request is a keeper tool, and
 * set_memory is among them" identifies the lane exactly, survives every
 * rewording of the instructions, and cannot be typed by a person.
 *
 * Kill switch: KADE_KEEPER_CARVEOUT=0 restores the old behaviour.
 */

/** The three tools `createMemoryProcessor` binds, and nothing else. */
const KEEPER_TOOLS = new Set(['set_memory', 'delete_memory', 'log_diary']);

function toolNamesOf(body) {
  const tools = Array.isArray(body && body.tools) ? body.tools : [];
  return tools.map((t) =>
    String((t && t.function && t.function.name) || (t && t.name) || '').toLowerCase());
}

/**
 * True for the platform's memory-keeper call.
 *
 * Deliberately strict on BOTH sides:
 *   - `set_memory` must be present, so a body carrying only `log_diary`
 *     (or only the delete tool) can never be mistaken for the keeper;
 *   - EVERY tool must be a keeper tool, so an ordinary agent that somehow
 *     gained one of these names still gets its style reminder.
 * A request that matches both is the keeper or nothing.
 */
function isMemoryKeeperShapedBody(body) {
  const names = toolNamesOf(body);
  if (names.length === 0) return false;
  if (!names.includes('set_memory')) return false;
  return names.every((n) => KEEPER_TOOLS.has(n));
}

module.exports = { KEEPER_TOOLS, isMemoryKeeperShapedBody, toolNamesOf };
