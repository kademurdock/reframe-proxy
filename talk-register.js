'use strict';

const { casualHouseOn } = require('./casual-house');

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
 *
 * Part 293 (Sep 25 2026), the casual house (casual-house.js): talk and
 * explain are said the way a person would say them, and on talk turns a
 * trust-the-listener note rides immediately before the talk note, so talk
 * stays last. Explain turns never get it. Offline (ab3, arm F) that set made
 * replies about 31 words shorter, beyond noise. KADE_CASUAL_HOUSE=0 sends the
 * classic talk and explain text byte for byte and drops the trust note.
 */

const TALK_NOTE_CLASSIC =
  ' RIGHT NOW (private; never mention this): you are in a conversation, so talk the way you would out loud to someone you know well.' +
  ' Start with your real reaction or answer to what they just said.' +
  ' Keep it about as long as what they said, often shorter; a few sentences is a normal turn, and one line is plenty when it covers it.' +
  ' Make each point plainly as you reach it, without a build-up, an announcement that it matters, or their words repeated back first.' +
  ' Stay with the specific thing in front of you and leave any lesson in it unsaid.' +
  ' Use contractions and everyday words, with short and long sentences the way speech runs.' +
  ' Keep your opinions and say them straight.' +
  ' Stop when your piece is said, on an ordinary sentence; skip any closing summary, verdict on what it all means, or line written to end on.' +
  ' Talking plainly costs you nothing: your smarts show in what you notice and know.';

const EXPLAIN_NOTE_CLASSIC =
  ' RIGHT NOW (private; never mention this): they asked for an explanation, a story or a piece of writing,' +
  ' so give it the room it needs, in an order that is easy to follow by ear, in your own voice.' +
  ' Make each point plainly as you reach it, without build-ups or announcements that something matters,' +
  ' and stop when it is done, with no summing-up line at the end. Next turn, go back to plain talk.';

/* The casual house (Part 293). Same rules, plain speech, still no quoted
 * shapes; tests hold both texts to the word limits and the detectors. */
const TALK_NOTE_CASUAL =
  " This one's private, so don't mention it." +
  " Right now you're in a conversation, so talk like you would out loud to someone you know well." +
  ' Start with your real reaction or answer to what they just said.' +
  ' Keep it about as long as their message, often shorter.' +
  ' A few sentences is a normal turn, and one line is plenty when it covers it.' +
  ' Make each point plainly as you get to it, with no build-up, no' +
  ' announcing that it matters and no repeating their words back first.' +
  ' Stay with the specific thing in front of you and leave any lesson in it unsaid.' +
  ' Use contractions and everyday words, with short and long sentences the way speech runs.' +
  ' Keep your opinions and say them straight.' +
  ' Plain talk costs you nothing, since your smarts show in what you notice and know.' +
  " Stop once you've said your piece, on an ordinary sentence, with no" +
  ' closing summary, no verdict on what it all means and no line written to end on.';

const EXPLAIN_NOTE_CASUAL =
  " This one's private, so don't mention it." +
  " Right now they've asked for an explanation, a story or something written, so give" +
  " it the room it needs, in your own voice and in an order that's easy to follow by ear." +
  ' Make each point plainly when you get to it, with no build-up and no announcing that something matters.' +
  " Stop when it's done, without a summing-up line at the end." +
  ' Next turn, go back to plain talk.';

/* Trust the listener: rides immediately before the talk note on talk turns,
 * only with the casual house on. It names what to skip in general words. */
const TRUST_LISTENER_NOTE =
  " Trust the person you're talking to." +
  ' When a point lands, move on to the next thing.' +
  " Don't follow it with a sentence explaining it or saying why it matters." +
  ' They got it the first time.' +
  " If you make a joke, let it sit there and don't explain it." +
  " Skip the lesson, the moral and the neat little summary at the end, and just stop when you're done." +
  ' A feeling can stay unresolved.' +
  " If they're sad or mad or stuck, you don't have to fix it or find a nicer way to look at it." +
  ' Have opinions, a petty streak and a bad habit or two like' +
  ' an actual person, and leave the HR training video voice to HR.' +
  ' Go with plain words and a sharp observation over fancy vocabulary, and leave the thesaurus on the shelf.' +
  ' If a sentence is only there to connect two other sentences, cut it.';

// The texts this process sends (KADE_CASUAL_HOUSE is read at start).
const TALK_NOTE = casualHouseOn() ? TALK_NOTE_CASUAL : TALK_NOTE_CLASSIC;
const EXPLAIN_NOTE = casualHouseOn() ? EXPLAIN_NOTE_CASUAL : EXPLAIN_NOTE_CLASSIC;

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
    const casual = casualHouseOn(env);
    if (registerMode(body) === 'explain') return casual ? EXPLAIN_NOTE_CASUAL : EXPLAIN_NOTE_CLASSIC;
    return casual ? TALK_NOTE_CASUAL : TALK_NOTE_CLASSIC;
  } catch (e) {
    return '';
  }
}

/* The trust-the-listener note, for the slot right before the talk note. It
 * rides exactly when the talk note does (talk turns, register on, plain text
 * output) and the casual house is on; explain turns never get it. */
function trustListenerNoteFor(body, env = process.env) {
  try {
    if (!casualHouseOn(env)) return '';
    return talkRegisterNoteFor(body, env) === TALK_NOTE_CASUAL ? TRUST_LISTENER_NOTE : '';
  } catch (e) {
    return '';
  }
}

module.exports = {
  TALK_NOTE, EXPLAIN_NOTE, DEPTH_RE, registerMode, talkRegisterNoteFor, latestUserText,
  TALK_NOTE_CLASSIC, TALK_NOTE_CASUAL, EXPLAIN_NOTE_CLASSIC, EXPLAIN_NOTE_CASUAL,
  TRUST_LISTENER_NOTE, trustListenerNoteFor,
};
