'use strict';

/* ── TALK, DON'T WRITE (Part 292, Sep 25 2026) ─────────────────────────────
 *
 * Her words: "they are still sounding extremely AI... a voice and cadence
 * that is unmistakably ai... College essay crap. We need that when we ask for
 * it, not as much in conversational settings right?"
 *
 * What the Part 292 diagnosis found in 45 real casual replies on her seat:
 * 30 of 41 ended on a crafted closing line, 9 of 24 casual replies were
 * whole short essays (claim, build-up, button), replies ran 4.5 times the
 * length of her casual messages, and 82% of the essay shapes were seen by no
 * detector. The register lives in the SHAPE of a reply, so it has to be set
 * before the reply is written, not edited afterwards.
 *
 * What the research says works (voice_research_web.md in the Part 292
 * record): describe the target register in plain positive words, keep it
 * short, and put it LAST, right before generation, every turn; a length
 * target does more than any phrase ban; never quote the unwanted shapes (a
 * quoted example gets copied, even under "don't").
 *
 * So this note is the very last thing in the proxy's tail. It says how to
 * talk, not what to avoid, and it names the unwanted moves only in general
 * words. It has two modes:
 *   talk     the default, for everything a friend says in conversation
 *   explain  when the latest message plainly asks for an explanation, a
 *            story, a piece of writing, a comparison or a breakdown: the
 *            reply gets the room and order it needs, still in voice, and the
 *            next turn goes back to talk.
 * The explicit wording of the request decides; when in doubt, talk (a thin
 * answer to a real question is fixed by asking "say more"; an essay in the
 * middle of a conversation cannot be un-heard).
 *
 * Tests hold the note to its own rule: it must read clean on the platform's
 * detectors and quote none of the shapes it steers away from.
 * Kill switch: KADE_TALK_REGISTER=0.
 */

const TALK_NOTE =
  ' RIGHT NOW (private; never mention this): you are in a conversation, so talk the way you would out loud to someone you know well.' +
  ' Start with your real reaction or answer to what they just said.' +
  ' Keep it about as long as what they said, often shorter; a few sentences is a normal turn, and one line is plenty when it covers it.' +
  ' Make each point plainly as you reach it, without a build-up, an announcement that it matters, or their words repeated back first.' +
  ' Stay with the specific thing in front of you and leave any lesson in it unsaid.' +
  ' Use contractions and everyday words, with short and long sentences the way speech runs.' +
  ' Keep your opinions and say them straight.' +
  ' Stop when your piece is said, on an ordinary sentence; skip any closing summary, verdict on what it all means, or line written to end on.' +
  ' Talking plainly costs you nothing: your smarts show in what you notice and know.';

const EXPLAIN_NOTE =
  ' RIGHT NOW (private; never mention this): they asked for an explanation, a story or a piece of writing,' +
  ' so give it the room it needs, in an order that is easy to follow by ear, in your own voice.' +
  ' Make each point plainly as you reach it, without build-ups or announcements that something matters,' +
  ' and stop when it is done, with no summing-up line at the end. Next turn, go back to plain talk.';

/* Plain requests for depth. Deliberately narrow: "why" and "how" alone are
 * everyday conversation ("why would he say that?"), so they only count in the
 * forms that ask how something works or how to do something. */
const DEPTH_RE = new RegExp([
  '\\bexplain\\b',
  '\\bwalk me through\\b',
  '\\bbreak (?:it|this|that) down\\b',
  '\\bteach me\\b',
  '\\bstep by step\\b',
  '\\bin (?:more )?detail\\b',
  '\\bdeep dive\\b',
  '\\bthe (?:whole|full|long) (?:story|version|thing)\\b',
  '\\b(?:five|5|ten|10)[- ]minute version\\b',
  '\\bpros and cons\\b',
  '\\bcompare\\b',
  "\\bwhat(?:'|\u2019)?s the difference\\b",
  '\\bwhat is the difference\\b',
  '\\bhow (?:does|do|did|would|could|can) (?:a |an |the )?[a-z][\\w\\s-]{0,40}\\bwork\\b',
  '\\bhow (?:do|can|should) i\\b',
  '\\bhow to\\b',
  '\\btell me (?:a |the )?story\\b',
  '\\b(?:write|draft|compose) (?:me |us |her |him )?(?:a|an|the|my|some)\\b',
  // Request verbs only: "you gave me an essay" is a complaint about length,
  // and the offline A/B (Part 292) caught the bare noun sending it to explain.
  '\\b(?:summari[sz]e|analy[sz]e|outline) (?:it|this|that|the|my|a|an|for me)\\b',
  '\\b(?:give|write) me (?:a |an |the )?(?:summary|essay|report|rundown|breakdown|history)\\b',
  '\\bhistory of\\b',
  '\\b(?:look (?:it |that |this )?up|research|search for|find out)\\b',
].join('|'), 'i');

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');
  }
  return '';
}

/* The latest human message, with delivery tags and quoted blocks removed so a
 * pasted article that happens to say "explain" does not flip the mode. */
function latestUserText(body) {
  const msgs = Array.isArray(body && body.messages) ? body.messages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && m.role === 'user') {
      return textOf(m.content)
        .replace(/%{3}[^%]*%{3}/g, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .slice(0, 2000);
    }
  }
  return '';
}

function registerMode(body) {
  const said = latestUserText(body);
  if (!said.trim()) return 'talk';
  return DEPTH_RE.test(said) ? 'explain' : 'talk';
}

function talkRegisterNoteFor(body, env = process.env) {
  try {
    if (String(env.KADE_TALK_REGISTER ?? '1') === '0') return '';
    if (!body || (body.response_format && body.response_format.type !== 'text')) return '';
    return registerMode(body) === 'explain' ? EXPLAIN_NOTE : TALK_NOTE;
  } catch (e) {
    return '';
  }
}

module.exports = { TALK_NOTE, EXPLAIN_NOTE, DEPTH_RE, registerMode, talkRegisterNoteFor, latestUserText };
