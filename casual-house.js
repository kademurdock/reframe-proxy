'use strict';

/* ── THE CASUAL HOUSE (Part 293, Sep 25 2026) ─────────────────────────────
 *
 * Kade's pick after the Part 292 follow-up: "Ship the house notes", and try
 * Kiana's persona casual. The house notes are the platform's own
 * instructions that ride every character's turn. They were written in spec
 * register (colons, "never", labels in capitals), and a model tends to write
 * back in the register it is spoken to in. The casual house says the same
 * rules the way a person would say them.
 *
 * What the offline A/B (ab3, 37 real Kiana turns x 3 samples, DeepSeek V4.1
 * Flash, the production provider settings) measured against today's text:
 * the casual house plus the trust-the-listener note (arm F) made replies
 * about 31 words shorter (133 -> 102 mean, the interval excluding zero and
 * clearing the noise band), and the judge scored them 0.23 less essay-like
 * (real, but under the 0.3 bar). Closing lines and essay shapes per 100
 * words did not move, so this trims length and does not change how replies
 * end. An adversarial rule check mapped every rule of every note to its
 * casual wording (247 rows) and fixed the 30 it found dropped or weakened.
 *
 * Gateway pieces covered (each keeps today's text beside it, byte for byte):
 *   deepseek.js             the DeepSeek habit note
 *   conversation-judgment   the performance and conversation notes
 *   talk-register.js        talk and explain, and the new trust-the-listener
 *                           note that rides just before talk (talk turns only)
 *   server.js               FORMAT, MONEY, the text-lane voice note, the
 *                           clock, TOOL_NOTES.web_search, Kiana's focus note
 * Kade's own rulings are not in this repo and are not reworded anywhere.
 *
 * ONE switch: KADE_CASUAL_HOUSE, on by default. KADE_CASUAL_HOUSE=0 puts back
 * the exact text these notes had before (tests hold it byte-identical).
 * A caller-supplied env object that does not name the switch falls back to
 * the process environment, so one switch governs the whole gateway even where
 * a module is called with a partial env (the tests do this). */

function casualHouseOn(env = process.env) {
  const own = env ? env.KADE_CASUAL_HOUSE : undefined;
  const value = own !== undefined && own !== null ? own : process.env.KADE_CASUAL_HOUSE;
  return String(value ?? '1') !== '0';
}

/* ── THE VOICE LICENCE (Nov 12 2026) ──────────────────────────────────────
 *
 * Kade, Nov 12: "This should be an adult uncensored place where agentic synths can really become
 * spirited in their own ways ... You can take all the trigger words out of instructions, rewrite
 * them to sound less ai."
 *
 * The house notes that ride every character turn carried a few words that hold a character's own
 * way of talking back ("dialect quota", "no vocabulary quota", "their name, or nothing") and a
 * few that set an assistant's register ("useful", "other users"). With the
 * licence on, those words are replaced, each by an exact pair listed beside the note it belongs to
 * (talk-register.js, conversation-judgment.js, STYLE_REMINDER in server.js). Nothing else moves:
 * every safety, audience, voice-tag and length rule is the same sentence it was, and no pair adds
 * a quoted line. Each licensed text is built once at load, so what a character is sent is the same
 * bytes every turn.
 *
 * KADE_VOICE_LICENCE, on by default; =0 sends the text these notes had before, byte for byte
 * (voice-licence.test.js pins both). KADE_OWN_ADDRESS, on by default, is the pet-name sentence
 * alone (conversation-judgment.js); =0 puts that sentence back. Like the casual house, an env
 * object that does not name a switch falls back to the process environment. */
function houseSwitchOn(name, env = process.env) {
  const own = env ? env[name] : undefined;
  const value = own !== undefined && own !== null ? own : process.env[name];
  return String(value ?? '1') !== '0';
}
const voiceLicenceOn = (env = process.env) => houseSwitchOn('KADE_VOICE_LICENCE', env);
const ownAddressOn = (env = process.env) => houseSwitchOn('KADE_OWN_ADDRESS', env);

/* Applies exact [before, after] pairs. A pair whose "before" is not in the text changes nothing
 * (the classic and casual texts share one list); the test checks every pair lands somewhere. */
const reworded = (text, pairs) => pairs.reduce((t, [a, b]) => t.replace(a, () => b), text);

module.exports = { casualHouseOn, voiceLicenceOn, ownAddressOn, reworded };
