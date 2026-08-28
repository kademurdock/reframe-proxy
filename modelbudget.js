'use strict';
/**
 * modelbudget.js — WHO CAN THINK, AND HOW MUCH ROOM THEY GET TO SPEAK.
 *
 * Extracted from server.js on Aug 24 2026 (Part 92.2) after the third
 * wordless-turn outage in one evening. It lives in its own file for the same
 * reason compaction.js does: the logic that decides whether a person gets
 * WORDS is worth a test that imports the real thing, not a copy of it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE BUG THAT MADE THIS FILE, AND IT IS THE SAME BUG TWICE
 * ══════════════════════════════════════════════════════════════════════════
 *
 * A MODEL-NAME PREDICATE IS A SAFETY SWITCH. When the fleet changes models,
 * every predicate keyed on the old name silently turns something OFF, and
 * nothing goes red — the feature just stops existing.
 *
 *   Aug 17 2026 — the fleet moved Moonshot → GLM. Auto-think was gated on
 *   isKimiModel(), so EVERY agent logged `skip: non-kimi model` and the whole
 *   router went dark. Fixed by adding isGlmModel.
 *
 *   Aug 21 2026 — Z.AI direct shipped. adaptForZai strips the `z-ai/` prefix
 *   because Z.AI's API wants a bare `glm-5.3`. GLM_MODEL_RE was anchored
 *   `/^z-ai\/glm/i`. So from the moment that switch went live,
 *   isReasoningModel(upstreamBody.model) answered FALSE for the entire fleet,
 *   and THE WORDLESS-TURN GUARD — written July 30 for Amber, generalized to
 *   GLM on Aug 17 — HAD BEEN DEAD FOR THREE DAYS. Nobody could have noticed:
 *   a disarmed guard logs nothing at all.
 *
 * Receipts, both from Aug 23 2026, both a real person getting silence:
 *   req 9vipwj (Forge)   finish=length completion=8000 reasoning=34073ch content=0
 *   req v6w0g2 (Amber A) finish=length completion=4000 reasoning=17523ch content=0
 *
 * ⚠️ THE RULE: a predicate that names models must accept EVERY spelling the
 * platform can produce for that model. If you add a lane that rewrites a model
 * string, grep for every `is<Something>Model` before you ship it.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SECOND BUG: TWO FUNCTIONS DISAGREED ABOUT WHETHER A TURN THINKS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * They ran in the same expression — adaptForZai(adaptForGlm(body)) — and
 * contradicted each other:
 *
 *   adaptForGlm saw `effort:'none'` and said "not thinking, needs no headroom"
 *                                    → returned the body untouched, no floor
 *   adaptForZai saw the same 'none' and said "glm-5.3 CANNOT stop thinking"
 *                                    → set thinking:enabled, effort:'low'
 *
 * So Amber A's turn was given no extra room precisely because it had been
 * declared not-thinking, and then made to think. It reasoned 17,523 characters
 * into a 4,000-token budget and said nothing.
 *
 * ⚠️ THE RULE: `effort:'none'` IS A REQUEST, NOT A GUARANTEE. GLM-5.3+ always
 * thinks — Z.AI's own docs say so and adaptForZai already encoded it. Ask the
 * MODEL what it does, never the caller what it wanted.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ON THE SIZE OF THE FLOORS
 * ══════════════════════════════════════════════════════════════════════════
 *
 * `max_tokens` IS A CEILING, NOT A SPEND. Measured live against Z.AI on
 * Aug 24 2026, `glm-5.3`, prompt "say ok":
 *
 *     max_tokens  16000 → completion  37
 *     max_tokens  32000 → completion 258
 *     max_tokens  65536 → completion 134
 *     max_tokens  98304 → completion 266
 *     max_tokens 131072 → completion 160
 *
 * Headroom is free. You are billed for tokens GENERATED. That is why these
 * numbers are large and why raising them is not a spending decision.
 *
 * The floors were 4000/8000 and both were hit dead-on in one evening. They
 * were sized in July against a measurement — "GLM reasons 110-230 tokens" —
 * that GLM-5.3 invalidated: it reasoned 7,998. ⚠️ A FLOOR SIZED AGAINST A
 * MEASUREMENT IS ONLY AS GOOD AS THAT MEASUREMENT'S AGE. Re-measure, or the
 * floor quietly becomes a cap.
 */

/* ── WHO IS WHO ─────────────────────────────────────────────────────────────
 * Both spellings, always. The optional `z-ai/` prefix is the whole fix. */
const GLM_MODEL_RE = /^(?:z-ai\/)?glm[-.]/i;
/* GLM-5.3+ cannot have thinking disabled (docs.z.ai/guides/llm/glm-5.3, and
 * probed live Aug 21 with error 1210). adaptForZai already knows this; the
 * budget path has to know it too, or it hands an always-thinking model a
 * not-thinking budget. */
const GLM_ALWAYS_THINK_RE = /^(?:z-ai\/)?glm-5\.[3-9]/i;

const KIMI_MODEL_MAP = {
  'moonshotai/kimi-k2.6': 'kimi-k2.6',
  'moonshotai/kimi-k3': 'kimi-k3',
  'kimi-k2.6': 'kimi-k2.6',
  'kimi-k3': 'kimi-k3',
};

function isKimiModel(model) {
  return Object.prototype.hasOwnProperty.call(KIMI_MODEL_MAP, String(model || '').toLowerCase());
}
function isGlmModel(model) {
  return GLM_MODEL_RE.test(String(model || ''));
}
function isReasoningModel(model) {
  return isKimiModel(model) || isGlmModel(model);
}
/** True when the model thinks whatever the caller asked for. */
function alwaysThinks(model) {
  return GLM_ALWAYS_THINK_RE.test(String(model || ''));
}

/* ── THE FLOORS ─────────────────────────────────────────────────────────── */
const GLM_THINK_MIN_TOKENS = Number(process.env.KADE_GLM_THINK_MIN_TOKENS || 16000);
const GLM_DEEP_MIN_TOKENS = Number(process.env.KADE_GLM_DEEP_MIN_TOKENS || 64000);

/**
 * Does this turn think? Asks the model first, the caller second.
 * @returns {'deep'|'think'|false}
 */
function thinkTierFor(body) {
  if (!body || !isGlmModel(body.model)) return false;
  const r = body.reasoning || {};
  const effort = typeof r.effort === 'string' ? r.effort.toLowerCase() : '';
  const asked = r.enabled === true || ['low', 'medium', 'high', 'xhigh'].includes(effort);
  // The model's nature outranks the caller's request.
  if (!asked && !alwaysThinks(body.model)) return false;
  const deep = ['high', 'xhigh'].includes(effort) || (r.enabled === true && !effort);
  return deep ? 'deep' : 'think';
}

/**
 * Give a thinking turn enough room to think AND still speak.
 * Idempotent: the floor only ever raises, never lowers a budget someone set.
 */
function adaptForGlm(body) {
  const tier = thinkTierFor(body);
  if (!tier) return body;
  const floor = tier === 'deep' ? GLM_DEEP_MIN_TOKENS : GLM_THINK_MIN_TOKENS;
  const mt = Number(body.max_tokens);
  if (Number.isFinite(mt) && mt >= floor) return body;
  return { ...body, max_tokens: floor };
}

/**
 * THE LAST LINE OF DEFENCE. A turn that produced no words is a failed turn,
 * whatever the provider called it and whatever it spent getting there.
 *
 * ⚠️ Deliberately does NOT require reasoning text to be present. The old guard
 * did (`reasoningAccum.length > 0`), which meant a turn that burned its budget
 * with reasoning EXCLUDED from the stream sailed straight through and served
 * silence. The person cannot see reasoning. They can only see words.
 */
function isWordlessTurn({ model, finishReason, contentLength }) {
  return isReasoningModel(model) && finishReason === 'length' && Number(contentLength) === 0;
}


/**
 * THE RESCUE, EXTRACTED (Aug 28 2026, per WORDLESS_GUARD_LAST_TWO_PATHS_SPEC).
 * One home for the re-ask every lane shares — the buffered guard, shim-live,
 * and phone-live all call THIS instead of keeping a copy. A second copy of
 * this logic is the same shape as the model-name predicate that sat in two
 * places and disarmed the guard for three days.
 *
 * `callOpenRouter` is passed in (server.js owns it) so this module keeps no
 * network of its own. `timeoutMs` > 0 puts a hard window on the re-ask — the
 * phone lane uses it because every second is dead air on an open line; the
 * screen lanes pass 0 and ride the deep timeout like always.
 *
 * Fail-soft in every direction: a rescue that dies, times out, or returns
 * empty yields null, and the caller proceeds exactly as it did before the
 * rescue existed. It can make a silent turn speak; it must never make a
 * working turn worse.
 */
async function rescueWordlessTurn({ upstreamBody, reqId, callOpenRouter, timeoutMs = 0, lane = 'buffered' }) {
  try {
    const fallbackBody = { ...upstreamBody, stream: false };
    delete fallbackBody.stream_options;
    delete fallbackBody.reasoning;
    delete fallbackBody.include_reasoning;
    delete fallbackBody.reasoning_effort;
    let call = callOpenRouter(fallbackBody);
    if (timeoutMs > 0) {
      call = Promise.race([
        call,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`rescue window (${timeoutMs}ms) closed`)), timeoutMs),
        ),
      ]);
    }
    const fb = await call;
    const fbText = fb && fb.choices && fb.choices[0] && fb.choices[0].message && fb.choices[0].message.content;
    if (typeof fbText === 'string' && fbText.trim().length > 0) {
      console.log(`[req ${reqId}] wordless rescue (${lane}) landed ${fbText.length} chars`);
      return { text: fbText, finishReason: fb.choices[0].finish_reason || 'stop' };
    }
    console.warn(`[req ${reqId}] wordless rescue (${lane}) returned no content -- leaving the turn as it was`);
    return null;
  } catch (e) {
    console.warn(`[req ${reqId}] wordless rescue (${lane}) failed: ${e.message} -- leaving the turn as it was`);
    return null;
  }
}

/* ⭐ AUG 28 2026 — THE SENSITIVE BLOCK GETS A VOICE. Her first two native-
 * vision turns ever: one died on an empty text part (fixed the same hour),
 * and the retry came back `finishReason=sensitive` with ZERO content — Z.AI's
 * content filter refused the image (probed direct: 400 code 1301,
 * contentFilter level 2 on the input; the photo was a hand-engraved pin-up on
 * a brass lighter). The app turned the silence into an error tone, and she
 * reported it as "still didn't work" — because from her side a filtered turn
 * and a broken platform are INDISTINGUISHABLE when both sound like silence.
 *
 * This is NOT the wordless guard's case and must not ride its rescue:
 * isWordlessTurn is finish=length (a budget problem — re-asking helps), and
 * a re-ask here would hit the same wall, while re-asking a REFUSED image
 * through a different provider is filter-evasion and is deliberately not
 * built. The honest cure is local and instant: say what happened, plainly,
 * and point at the Describe lane that already exists in the app (different
 * provider, her explicit tool, her explicit choice — a person retrying a
 * tool is not a proxy silently rerouting refused content).
 *
 * 'content_filter' is OpenAI/OpenRouter's spelling of the same verdict, so
 * the fallback lane speaks too instead of going quiet a different way. */
const SENSITIVE_FINISHES = new Set(['sensitive', 'content_filter']);
function isSensitiveBlockedTurn({ finishReason, contentLength }) {
  return SENSITIVE_FINISHES.has(String(finishReason || '')) && Number(contentLength) === 0;
}
function sensitiveBlockedNotice(upstreamBody) {
  let hasImage = false;
  const msgs = (upstreamBody && upstreamBody.messages) || [];
  for (const m of msgs) {
    if (m && Array.isArray(m.content) && m.content.some((p) => p && p.type === 'image_url')) {
      hasImage = true;
      break;
    }
  }
  const text = hasImage
    ? 'That picture got stopped at the door — the company that runs my language model puts its own content filter on images, and it refused this one before I saw a single pixel. Not my call, and no judgment from me. If you want eyes on it anyway, the Describe tool in the app uses a different service and will usually look. Or just tell me about it and we go from there.'
    : "That message tripped the model provider's content filter before it ever reached me, so I've got nothing to work with on my end. Say it another way and I'm right here.";
  return { text, finishReason: 'stop' };
}

/* ⭐ AUG 28 2026, LATER THE SAME EVENING — ONE FILTERED PHOTO MUST NOT
 * POISON THE WHOLE THREAD. Her follow-up report: a picture of HERSELF also
 * refused. Probed alone against the pot it described perfectly ("a close-up
 * selfie of a person with light hair and freckles...") — the selfie was
 * innocent. What actually happened: the conversation REPLAYS its history,
 * old image parts included, so the lighter photo the filter refused at
 * 20:04 rode along under her selfie at 20:29 (both fingerprints in the same
 * request, receipts in the log) and Z.AI refused the whole turn again. One
 * bad image = a permanently dead conversation, with no way for anyone to
 * know why.
 *
 * THE CURE, and why it is not filter evasion: on a sensitive block, retry
 * ONCE with every image from EARLIER turns removed — replaced by a plain
 * text placeholder — while the newest user message keeps its images intact.
 * The already-refused content is DROPPED, not smuggled: the provider's
 * verdict on the old image is respected by removing it. If the newest image
 * is itself the flagged one, the retry blocks too and the honest notice
 * stands exactly as before. Both outcomes are correct. */
function stripPriorImages(messages) {
  if (!Array.isArray(messages)) return { messages, stripped: 0 };
  let lastImageUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && Array.isArray(m.content) &&
        m.content.some((p) => p && p.type === 'image_url')) {
      lastImageUserIdx = i;
      break;
    }
  }
  if (lastImageUserIdx === -1) return { messages, stripped: 0 };
  let stripped = 0;
  const out = messages.map((m, i) => {
    if (i === lastImageUserIdx || !m || !Array.isArray(m.content)) return m;
    if (!m.content.some((p) => p && p.type === 'image_url')) return m;
    const parts = m.content.map((p) => {
      if (p && p.type === 'image_url') {
        stripped += 1;
        return { type: 'text', text: '[an earlier photo from this conversation was removed]' };
      }
      return p;
    });
    return { ...m, content: parts };
  });
  return { messages: stripped > 0 ? out : messages, stripped };
}

module.exports = {
  GLM_MODEL_RE,
  GLM_ALWAYS_THINK_RE,
  KIMI_MODEL_MAP,
  GLM_THINK_MIN_TOKENS,
  GLM_DEEP_MIN_TOKENS,
  isKimiModel,
  isGlmModel,
  isReasoningModel,
  alwaysThinks,
  thinkTierFor,
  adaptForGlm,
  isWordlessTurn,
  rescueWordlessTurn,
  isSensitiveBlockedTurn,
  sensitiveBlockedNotice,
  stripPriorImages,
};
