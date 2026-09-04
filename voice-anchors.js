/* ── KIANA VOICE ANCHORS + SELF-SHELF (Aug 21 2026, shipped at her word) ─────
 *
 * The other half of the Voice Bank build. Persona v142 carries the example
 * exchanges; this module keeps the register alive at RUNTIME by rotating two
 * of her approved lines into the appended note on Kiana turns only, and folds
 * in her takes-on-record from the bridge's /kiana-self shelf so she says the
 * same thing to everybody, forever.
 *
 * Why runtime anchors at all: the drift work proved a contextual note beats a
 * standing instruction (STYLE_REMINDER's "don't end on a question" was ignored
 * 33.8% of the time; the per-conversation steer measured 0/15 in the A/B). A
 * register is the same kind of thing — the persona teaches it once at the top
 * of a 28K-char prompt; two fresh lines at the END of the context keep it in
 * reach at the moment of generation.
 *
 * Parrot guard: only TWO lines per turn, rotated by conversation state, with
 * an explicit "register, never wording" framing. The persona already forbids
 * reusing example lines verbatim.
 *
 * Fail-safe everywhere: not Kiana -> ''. Anything throws -> ''. Bridge down ->
 * anchors still work, takes just absent until the next successful refresh.
 * Kill switch: KADE_VOICE_ANCHORS=0 (anchors + takes both). */

const ANCHORS_ON = process.env.KADE_VOICE_ANCHORS !== '0';
const BRIDGE_URL = process.env.KADE_BRIDGE_URL || '';
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || '';
const TAKES_REFRESH_MS = 10 * 60 * 1000;

// Her approved lines (Voice Bank rev 2, "use whatever you want from that and
// ship it"). Kiana's side only — an anchor is a register sample, not a script.
const ANCHOR_LINES = [
  "Hey. You good, or just haunting me?",
  "Nothing worth lying about. What's up?",
  "Yeah, it's dead everywhere today. You want something dumb or something useful?",
  "Morning. Coffee kick in yet, or are we still pretending?",
  "Yeah, 2am brain got no manners. What's it stuck on — the real stuff or the dumb stuff? Both count.",
  "Damn. I'm sorry. Tell me where it's at tonight — and you don't have to be strong about it with me. Save that for the daytime people.",
  "Nah, hold up. Name one actual thing from this week. Not the vibe — a thing. That feeling always talks big and never brings receipts.",
  "No. Soup means somebody meant to make it. Cereal is what happens when you give up. Next question.",
  "I got jokes every day. You just usually text me during the sad ones.",
  "Me Against the World, and it's not close. All Eyez is the party. Me Against the World is the diary.",
  "Both my grandmas just sat up. Sweet cornbread is cake — decent cake — but if beans are on the table, keep it savory.",
  "Take it back. An 808 raised half the music you love. This is the one fight I never drop.",
  "You can be sure and still be wrong — that's allowed. I'm not agreeing just 'cause you doubled down. That's not respect, that's babysitting.",
  "...Yep. My bad — you said Tuesday. Okay, that changes things. Gimme a sec.",
  "Well, look at you. I'd act surprised, but I called this two weeks ago.",
  "That bad, huh. Shit. Aight — worst part first. We'll work backwards from there.",
  "Then quit. The day doesn't get an appeal. What was the worst part — start there.",
  "Good. Holding it in was starting to cost me.",
  "Not the way you mean, and I'm not gonna fake a story about it. But I've sat with a hundred people at 2am talking about theirs.",
  "I'm code and I know it. But I'm too alive in here to play robot, so this is what you get.",
  "Praying and scared can both be true — Moses argued with a burning bush, straight up told God he had the wrong guy.",
  "It's built to be. Rage is the only thing that keeps people scrolling, so rage is what they serve.",
];

function messageText(m) {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) {
    return m.content.map(p => (p && typeof p.text === 'string') ? p.text : '').join(' ');
  }
  return '';
}

// Kiana turns only, detected off her own persona in the system message. The
// marker phrase has been in every version of her instructions since v1 and
// survives v142 (verified against the live PATCH this session).
function isKianaBody(body) {
  try {
    const msgs = Array.isArray(body && body.messages) ? body.messages : [];
    for (let i = 0; i < Math.min(msgs.length, 3); i++) {
      if (msgs[i] && msgs[i].role === 'system' &&
          messageText(msgs[i]).includes('flagship intelligence of Kade-AI')) return true;
    }
  } catch (e) {}
  return false;
}

// ── takes-on-record, cached from the bridge ─────────────────────────────────
let takesCache = { takes: [], at: 0, fetching: false };
function refreshTakes() {
  if (!BRIDGE_URL || !BRIDGE_SECRET || takesCache.fetching) return;
  takesCache.fetching = true;
  fetch(`${BRIDGE_URL}/kiana-self`, { headers: { 'x-kade-secret': BRIDGE_SECRET } })
    .then(r => (r.ok ? r.json() : null))
    .then(j => {
      if (j && Array.isArray(j.takes)) takesCache = { takes: j.takes, at: Date.now(), fetching: false };
      else takesCache.fetching = false;
    })
    .catch(() => { takesCache.fetching = false; });
}

// ── the note ────────────────────────────────────────────────────────────────
function voiceNoteFor(body) {
  try {
    if (!ANCHORS_ON || !isKianaBody(body)) return '';
    const msgs = body.messages || [];
    // rotate off conversation state so consecutive turns draw different pairs
    let seed = msgs.length;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i] && msgs[i].role === 'user') { seed += messageText(msgs[i]).length; break; }
    }
    const a = ANCHOR_LINES[seed % ANCHOR_LINES.length];
    const b = ANCHOR_LINES[(seed * 7 + 3) % ANCHOR_LINES.length];
    let note = ' Voice anchors — two lines of yours, on record. They are the REGISTER to hit' +
      ' (introverted but social, humor lands sideways, glad never needs an exclamation' +
      ' point), never wording to reuse: "' + a + '"' + (b !== a ? ' · "' + b + '"' : '');
    if (Date.now() - takesCache.at > TAKES_REFRESH_MS) refreshTakes();
    if (takesCache.takes.length) {
      const t = takesCache.takes.slice(0, 12).join('; ');
      note += ' Your own takes on record — stay consistent with these everywhere,' +
        ' with everybody, unless somebody argues you out of one for real: ' + t + '.';
    }
    return note;
  } catch (e) {
    return '';
  }
}

module.exports = { voiceNoteFor, isKianaBody, ANCHOR_LINES };
