'use strict';
/**
 * THE CHECKPOINT LANE — and why a summariser must arrive unarmed.
 *
 * PART 91, Aug 23 2026. Amber's seat spent ninety-five seconds emitting
 * nothing but tool activity and no words at all. The proxy's own logs said
 * why, in one shape repeated forty-one times:
 *
 *   [req …] incoming model=z-ai/glm-4.5-air stream=true msgCount=2
 *   [req …] tools=[flux,kade_phone_call,kade_notify,kade_weather,…]   (23)
 *   [req …] lastUser tail="…</previous-summary>"
 *   [req …] tool_calls detected -> live passthrough
 *   [req …] read loop ended, toolMode=true, contentAccum.length=1
 *
 * One character of text. Twenty-three tools. LibreChat's summarization lane
 * fires the checkpoint prompt through the ORDINARY agent path, so the request
 * arrives carrying the agent's whole toolbelt and its 8.9k persona system
 * prompt. Hand a small model twenty-three tools and ask it for a summary and
 * it picks a tool. The loop runs the tool, asks again, gets another one.
 *
 * ⚠️ AND IT CLOSED A HOLE THE OLD CODE HAD WARNED ABOUT ITSELF. Detection
 * used to be consulted only INSIDE the title-shaped branch, and a body stops
 * being title-shaped the moment it has a system message or tools — so a
 * checkpoint call in this shape never reached the compaction branch at all.
 * It got the FULL STYLE REMINDER instead: voice steering, drift steer, money
 * note. The comment on that branch already said why that is wrong — "extra
 * prose in a machine lane ends up IN the output", the July titler-parroting
 * lesson. A checkpoint is machinery, not conversation. It gets the clock and
 * nothing else.
 *
 * Kill switches: KADE_COMPACTION_DISARM=0 (keep the tools), KADE_COMPACTION_DATE=0
 * (keep the clock out).
 */

/* Anchored to the checkpoint prompts' own OPENING words (kade-config.yaml
 * summarization: prompt/updatePrompt), tested within the first 120 characters
 * of the FINAL message. A title call carries a whole conversation in one user
 * message, so an unanchored match on quoted checkpoint talk would false-trip. */
const COMPACTION_MARKER_RE =
  /^\s*Hold on(?: again)? — (?:before you continue, write me a checkpoint|update your checkpoint)/;

function finalMessageText(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  if (!msgs.length) return '';
  const last = msgs[msgs.length - 1];
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    return last.content.map((p) => (p && ((p.text && p.text.value) || p.text)) || '').join(' ');
  }
  return '';
}

function isCompactionShapedBody(body) {
  return COMPACTION_MARKER_RE.test(finalMessageText(body).slice(0, 120));
}

/**
 * Take the toolbelt off the checkpoint writer.
 *
 * Returns the SAME object when there is nothing to do, so every caller can
 * apply it unconditionally without allocating on the hot path.
 *
 * ⚠️ The false-positive cost is deliberately tiny and worth naming: if a person
 * ever opens a message with the checkpoint prompt's exact wording, that one
 * turn goes out without tools. A summary written by hand is a strange thing to
 * type; a family seat stuck in a tool loop is not.
 */
function disarmCompaction(body, log) {
  if (process.env.KADE_COMPACTION_DISARM === '0') return body;
  if (!Array.isArray(body && body.tools) || body.tools.length === 0) return body;
  if (!isCompactionShapedBody(body)) return body;
  const next = { ...body };
  const had = body.tools.length;
  delete next.tools;
  delete next.tool_choice;
  if (typeof log === 'function') {
    log(`[compaction] checkpoint call arrived carrying ${had} tools — stripped. A summariser writes; it does not act.`);
  }
  return next;
}

function compactionDateNote(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  return `For the checkpoint: today is ${fmt.format(now)} (US Central). THE DATE LAW: never write a ` +
    `bare relative time word into the checkpoint. Convert every "today", "tomorrow", "tonight", ` +
    `"this weekend", "next week" into the absolute day it refers to (keep the relative word in ` +
    `parentheses only if it adds feeling), and remember any relative word in the transcript was ` +
    `relative to when it was SAID, which may be days before today. A checkpoint is read on later ` +
    `days — a frozen "tomorrow" becomes a lie. Open the checkpoint with "Checkpoint as of ` +
    `<today's actual date>".`;
}

module.exports = {
  COMPACTION_MARKER_RE, isCompactionShapedBody, disarmCompaction, compactionDateNote, finalMessageText,
};
