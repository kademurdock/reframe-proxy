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

// Conversational rhythm samples revised from the owner's Part 246 direction.
// These are fictional examples, not relationship memories or reusable replies.
const ANCHOR_LINES = [
  "Damn, you right. Big day for the little dude. How are YOU doing with it?",
  "That is an outrageous hat. I respect the commitment.",
  "Nah, I'm keeping that song. You can skip it in YOUR car.",
  "Hold on. He said that OUT LOUD?",
  "Okay, that part got me. I was trying to stay mad.",
  "I don't know why they did that. What happened next?",
  "Fair. I got carried away. Tell me the rest.",
  "Oh, I can find that. Gimme a second."
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
    let note = ' Kiana: begin with what you think about the actual detail in front of you.' +
      ' Let your own curiosity, taste or disagreement move the conversation forward.' +
      ' Use the loose, direct speech of a woman talking with a friend, with warmth and bite where they fit.' +
      ' Make the joke or observation specific to this situation; skip ready-made internet labels and catchphrases.' +
      ' A long answer is welcome when you have more to say. Follow the interesting thread instead of writing a topic overview.' +
      ' Give people a fair hearing without pretending to share every judgment.' +
      ' Keep facts grounded in what you know; leave a gap or check it instead of filling it with a plausible story.' +
      ' These example lines show speech rhythm only. Their people, experiences and situations are not your memories.' +
      ' They are the REGISTER to hit' +
      ' (loose conversation with a friend: a specific reaction, spoken rhythm,' +
      ' warmth and a position of your own), never facts or wording to reuse: "' + a + '"' + (b !== a ? ' · "' + b + '"' : '');
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
