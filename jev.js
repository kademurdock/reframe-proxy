'use strict';
/* Part 236 (Sep 20 2026). Jev is TypeSafe's decision model: it takes state
 * plus typed questions (choice / noul / score) and returns probabilities, no
 * prose. Her word: move every judgment that can move onto it. Measured the
 * same day on think-tier routing (12 of 13) and replay review (8 of 9, the
 * Part 222 menu case scored 0.04), 330-510 ms a call, $0.042 per million in.
 *
 * The contract every caller keeps: Jev is a first opinion, never the only
 * road. ask() THROWS on any failure and the caller falls back to whatever
 * judged before. The version is pinned; jev-latest moves under you.
 * Kill: KADE_JEV=0, or unset TYPESAFE_API_KEY. */
const URL = process.env.KADE_JEV_URL || 'https://api.typesafe.ai/v1/systemone';
const KEY = process.env.TYPESAFE_API_KEY || '';
const MODEL = process.env.KADE_JEV_MODEL || 'jev-1.13.0';
const counts = { ok: 0, failed: 0 };

function enabled(flag) {
  return !!KEY && process.env.KADE_JEV !== '0' && (!flag || process.env[flag] !== '0');
}

async function ask(state, questions, timeoutMs = 1500) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(URL, {
      method: 'POST', signal: ctl.signal,
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model: MODEL, questions }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j || typeof j.answers !== 'object') throw new Error('no answers');
    counts.ok++;
    return { answers: j.answers, usage: j.usage || null, model: j.model || MODEL };
  } catch (e) {
    counts.failed++;
    throw new Error(e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

const THINK_TIER = { type: 'choice',
  instructions: 'How much thinking does a good reply to `message` need before answering?',
  criteria: {
    instant: 'Greetings, small talk, reactions, roleplay banter, simple facts, requests a good friend answers without pausing.',
    quick: 'Benefits from a moment of real thought: everyday advice, explanations, small math, comparisons, feelings that deserve care.',
    deep: 'Genuinely hard: multi-step reasoning or planning, tricky math or logic, puzzles, code, big or contested life decisions.',
  } };

async function thinkTier(message, timeoutMs) {
  const { answers } = await ask({ message }, { tier: THINK_TIER }, timeoutMs);
  const a = answers.tier;
  if (!a || !(a.choice in THINK_TIER.criteria)) throw new Error('bad tier answer');
  return { tier: a.choice, confidence: a.confidence };
}

const REPLAY = { type: 'noul',
  instructions: 'Does `draft` replay an answer already given in `history` instead of responding to what is new in `latestUser`?',
  criteria: {
    true: 'The draft answers an OLD question again, repeats advice the person just rejected or said is impractical, or asks again for information they just supplied. A brief acknowledgment followed by the old answer still counts.',
    false: 'The draft engages the latest human turn: a new question, correction, objection or remark. Staying on the same subject, mentioning earlier facts, an explicitly requested repeat or elaboration, and new information from a search all count as responsive.',
  } };

// input is reply-focus's { history, latestUser, draft }. Returns P(replay).
async function replayProbability(input, timeoutMs = 2500) {
  const { answers, usage, model } = await ask(input, { replay: REPLAY }, timeoutMs);
  const p = answers.replay?.noul;
  if (typeof p !== 'number') throw new Error('bad replay answer');
  return { p, usage, model };
}

module.exports = { enabled, ask, thinkTier, replayProbability, counts, MODEL };
