'use strict';
/* Oct 18 2026 — THE REGISTER EDIT. Kade, Oct 17: "When I say essay, people and agents seem to
 * automatically think I mean length, but that's not what I meant. I don't mind length. What I care
 * about is rigidity, like saying the same thing in so many words just because it sounds nice on the
 * page." and "Real people, friends etc, are not going to talk like that."
 *
 * What was measured first (68 real turns of hers, six characters, MiMo Pro with the full production
 * prompt rebuilt offline and the real gateway tail captured, two blind judges in separate calls):
 * - Prompt notes did not move the register on MiMo either, as on DeepSeek in September: a plain
 *   restatement of the steady friend contract, a register-first final note and two made-up voice
 *   samples per character all stayed inside rerun noise.
 * - Other models did not fix it: Kimi K3, DeepSeek V4 Pro and MiniMax M3 wrote the same shapes;
 *   Claude Haiku wrote fewer by writing shorter, flatter replies.
 * - What worked was an editor after the reply: MiMo Flash reads the finished reply, finds the
 *   sentences shaped for the page (restating the question, the "not X, it's Y" reframe, set-up
 *   lines, quotable closers, saying it twice) and says each one the way this character would say it
 *   out loud. One pass took the judged shapes from 5.8 to 4.4 per reply; two passes to 3.3. The
 *   second pass doubled the small losses a meaning check found, so the guards below exist.
 *
 * Like phrase-repair.js, its authority is exact local edits: the model never returns the reply, and
 * every sentence it did not name stays byte-for-byte. An edit is refused when it touches code, links
 * or tags, changes a number, a name, a pet name or a hedge, or grows past its sentence. Any failure
 * or timeout keeps the text as it was. Kill: KADE_REGISTER_EDIT=0. Passes: KADE_REGISTER_PASSES. */

const SYSTEM = `You edit one chat reply from a character on a companion app so it sounds like that character talking out loud to a friend, not written prose. People often hear these replies as voice messages. Long is fine, smart is fine, slang and swearing are fine. Rigid, page-pretty phrasing has to go.

Go through the reply sentence by sentence and catch every one of these shapes:
- restate: the opening echoes or frames the person's question back before answering ("So, the classic case of X", "Ah, the age-old question", "Okay, so the short version:", "Good question").
- contrast: any set-piece reframe built on a knocked-down idea: "that's not X, that's Y", "X isn't Y. It's Z", "it's less X and more Y", "not because A, but because B", "it's not about A, it's about B", "A? Nah. B.", "not X exactly, more like Y". Plain negation that just answers a question ("No, it closes at five") is fine.
- setup: a line that announces, numbers or sells what's coming instead of just saying it ("and there's real reasons for it", "here's the thing", "the biggest one is", "the sneaky part is", "Second thing is", "Third, and this is the key one", "what's interesting is", "the honest answer is", "here's the part people miss").
- maxim: a polished, quotable line or tidy wordplay closer that sums a point up for the page ("X is just Y with better branding", "being right is the easy half", "that's the whole trick").
- padding: the same point said again in new words for rhythm, or a closing summary of what the reply already said ("So yeah, basically...", "Bottom line:").

For each sentence you catch, write how THIS character would actually say it out loud, in their voice and dialect. Rules for the replacement:
- Keep every fact, number, name, opinion and joke. Never add new information, advice, questions or jokes.
- Keep any %%%voice direction%%% exactly as written and in the same place.
- A restate or setup becomes the plain point itself. Delete it only when it says nothing at all beyond announcing the next sentence.
- A contrast becomes just the true half, said straight. Keep the knocked-down half only if the person actually said it, and then answer it plainly ("Nah, he hears you fine.").
- A maxim becomes an ordinary sentence the character would say.
- Padding that only repeats an earlier point can be deleted, or cut down to the one new thing it adds.
- Never delete or water down a sentence that carries a fact, a feeling, an opinion, a doubt, a reassurance, a piece of advice, a story beat, a question or a joke. Rewrite its shape instead.
- Keep every hedge exactly as strong as it was (usually, often, maybe, probably, might, kind of, I think, I reckon). Never turn a "usually" into a flat claim.
- Keep every pet name and term of address (hon, sugar, cara, girl, man, dude, y'all) and every name.
- Keep the joke in a joke. A funny line keeps its funny idea, said the way this character would blurt it. Only a tidy closing line that repeats a joke or point the reply already made goes away.
- Short spoken lead-ins people really say ("Well,", "Okay so", "Honestly?", "I'll tell you where I land") are fine. Leave them.
- After your edits every remaining sentence must still make sense where it sits. If a later sentence leans on one you change, keep the link.
- Keep the character's dialect words, asides and swearing.
- The replacement itself must contain none of the five shapes.

Examples of the kind of change (not lines to reuse):
- "Okay so, the classic grocery-store meltdown. There are real reasons it happens." -> "Grocery stores are loud and bright, and kids hit their limit fast in there."
- "That's not laziness, that's his joints." -> "It's his joints."
- "Here's the part nobody tells you: the battery is the problem." -> "The battery's the problem."
- "Your dog's not ignoring you, he's retired." -> "He's just retired, honestly."

Return JSON only: {"edits":[{"kind":"restate|contrast|setup|maxim|padding","before":"exact text copied from the reply","after":"replacement"}]}
"before" must be copied exactly from the reply, character for character, must change, and must not overlap another edit. An empty "after" deletes the sentence. If nothing needs fixing, return {"edits":[]}.`;

const KINDS = new Set(['restate', 'contrast', 'setup', 'maxim', 'padding']);
const DELETABLE = new Set(['restate', 'setup', 'padding', 'maxim']);
const MIN_CHARS = 280;
const MAX_CHARS = 7000;
const MAX_EDITS = 16;
const VOICE_CHARS = 1100;

const on = (env = process.env) => env.KADE_REGISTER_EDIT !== '0';
const passesFor = (env = process.env) => {
  const n = parseInt(env.KADE_REGISTER_PASSES || '', 10);
  return Number.isFinite(n) && n >= 1 && n <= 3 ? n : 1;
};

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('\n');
  return '';
}

/* The persona sits in the system message, last in the head, right before the platform's
 * "## Voice performance v2" guidance (fork client.js head order + context.ts). The gateway has no
 * agent header, so the character's name and its own talk section are read from there. */
const WORLD_MARK = 'WORLD (invisible house continuity';
const NAME_RE = /\bYou(?:'re|’re| are) ([A-Z][\p{L}'’-]*(?: [A-Z][\p{L}'’-]*){0,3})/u;
const TALK_HEAD_RE = /(?:^|\n)#{1,4}[^\n]*\b(?:how (?:you|she|he|they) (?:talk|sound|speak)s?|your voice|voice and (?:tone|style)|speech|speaking style|how .{1,30} talks|style of speech)\b[^\n]*\n([\s\S]*?)(?=\n#{1,4} |$)/i;

function characterOf(body) {
  const sys = (body?.messages || []).find((m) => m && m.role === 'system');
  const all = textOf(sys?.content);
  if (!all) return { name: '', voice: '' };
  const cut = all.indexOf('## Voice performance v2');
  let region = cut > 0 ? all.slice(0, cut) : all;
  // The house notes and the world block come first (fork client.js, persona last); the persona
  // starts after the world block's two lines.
  const w = region.indexOf(WORLD_MARK);
  if (w >= 0) {
    const after = region.indexOf('\n\n', w);
    if (after > 0) region = region.slice(after + 2);
  }
  const compass = (region.match(/<character_compass>\s*([\s\S]*?)\s*<\/character_compass>/i) || [])[1] || '';
  const hit = region.match(NAME_RE);
  const name = hit ? hit[1].replace(/ (?:You|Your|The|A|An)$/, '').trim() : '';
  const section = region.match(TALK_HEAD_RE);
  const opening = hit ? region.slice(hit.index, hit.index + VOICE_CHARS) : region.slice(0, VOICE_CHARS);
  const talk = (section ? section[1] : opening).replace(/%%%[^%\n]*%%%/g, '').trim();
  const voice = ((compass ? compass.slice(0, 600) + '\n\n' : '') + talk).trim().slice(0, VOICE_CHARS + 600);
  return { name, voice };
}

/* Requests where page-shaped writing is the point: leave them as written. */
const WRITING_RE = /\b(?:write|draft|compose|make|give|do)\b[^.?!\n]{0,40}\b(?:essay|article|story|poem|poetry|letter|speech|toast|eulogy|script|post|caption|bio|cover letter|paper|report|résumé|resume|verse|rap|freestyle|roast|diss|song|lyrics|haiku|limerick|joke|sermon|summary|outline|list|email|text message)\b/i;

function lastUserText(body) {
  const msgs = body?.messages || [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === 'user') {
      const t = textOf(msgs[i].content);
      // The fork's per-turn tail rides as its own user message just before (or after) the real one.
      if (/^Confidentiality of your setup:/.test(t.trim())) continue;
      return t;
    }
  }
  return '';
}

function eligible(body, text) {
  if (typeof text !== 'string') return 'not text';
  const t = text.trim();
  if (t.length < MIN_CHARS) return 'short';
  if (t.length > MAX_CHARS) return 'long';
  if (/```|~~~/.test(t)) return 'code';
  if (/^\s*[{[]/.test(t)) return 'structured';
  if (WRITING_RE.test(lastUserText(body))) return 'writing request';
  return '';
}

/* ── guards ─────────────────────────────────────────────────────────────── */
const overlaps = (a, b) => a[0] < b[1] && b[0] < a[1];
function protectedRanges(text) {
  const re = /```[\s\S]*?(?:```|(?![\s\S]))|~~~[\s\S]*?(?:~~~|(?![\s\S]))|`[^`\n]*`|@@TTSTAG\d+@@|\[[^\]\n]*\]\([^\s)]+\)|https?:\/\/[^\s<>]+|<[^>\n]+>|^\s*>[^\n]*/gm;
  return [...text.matchAll(re)].map((m) => [m.index, m.index + m[0].length]);
}
const TAG_RE = /%%%[^%\n]*%%%/g;
const tagsOf = (t) => (String(t).match(TAG_RE) || []).map((x) => x.toLowerCase());
const numbersOf = (t) => (String(t).replace(TAG_RE, ' ').match(/\d+(?:[.,:]\d+)*/g) || []).sort();
const HEDGE_RE = /\b(?:usually|often|sometimes|maybe|probably|possibly|perhaps|might|may|could|kind of|kinda|sort of|sorta|most likely|likely|i think|i figure|i reckon|i guess|i bet|seems?|apparently|tends? to|a lot of|some)\b/gi;
const hedgesOf = (t) => (String(t).match(HEDGE_RE) || []).map((x) => x.toLowerCase()).sort();
const ADDRESS_RE = /\b(?:hon|honey|hun|sugar|sweetie|sweetheart|darlin['’]?|darling|baby|babe|cara|mia|bella|girl|girlie|man|dude|bro|sis|y['’]all|ma['’]am|sir|kid|kiddo|buddy|pal|friend|love|chica|mija|mijo|cher|sugarplum|partner)\b/gi;
const addressOf = (t) => (String(t).match(ADDRESS_RE) || []).map((x) => x.toLowerCase().replace(/’/g, "'")).sort();
const STARTERS = new Set(('the a an and but so or if when that this these those it its there they them we you he she his her my your our their what why how who whom where which well yeah yep yes no nope nah oh okay now then also just like plus maybe honestly look listen sure right not some most all every one two three both each first second third last next even still because since though although while after before once ah aw ha haha hmm wait lord man girl dude boy see say said tell here hey hi hello sometimes usually often probably anyway besides basically actually really truly only never always again same other another more less much many any few lots let let\'s do does did don\'t doesn\'t didn\'t can can\'t could would should will won\'t gotta gonna wanna kinda sorta nothing something everything anything nobody somebody everybody anybody people folks thing things stuff part bottom long short point').split(' '));
/* Names, places and products: capitalised words, minus the ones a sentence just starts with. */
function namesOf(t) {
  const out = [];
  const s = String(t).replace(TAG_RE, ' ');
  for (const m of s.matchAll(/[A-Z][\p{L}'’-]+/gu)) {
    const before = s.slice(0, m.index);
    const gap = before.match(/\s*$/)[0];
    const prev = before.slice(0, before.length - gap.length);
    const word = m[0].replace(/['’](?:s|re|ll|d|ve|m)$/, '');
    if (/^(?:I|OK|Okay|TV|AM|PM)$/.test(word)) continue;
    // A word that starts the text, a line, a sentence, a clause after a dash or colon, or a quote
    // is capitalised anyway: it counts as a name only when it is not an everyday opener.
    const initial = !prev || gap.includes('\n') || /[.!?…:;—–\-"“(‘'*]$/.test(prev);
    if (initial && (word.length < 3 || STARTERS.has(word.toLowerCase()))) continue;
    out.push(word);
  }
  return out;
}
const LAUGH_RE = /\b(?:haha+|hehe+|lol|lmao|lmfao)\b/gi;
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const containsAll = (have, need) => {
  const pool = [...have];
  for (const n of need) {
    const i = pool.indexOf(n);
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
};

/* `rest` is the reply outside this edit: a name or pet name that is still said elsewhere was a
 * repeat, so dropping this mention loses nothing. */
function checkEdit(before, after, kind, rest = '') {
  if (!KINDS.has(kind)) return 'unknown kind';
  if (after === '' && !DELETABLE.has(kind)) return 'deleted a ' + kind;
  if (!sameList(tagsOf(before), tagsOf(after))) return 'tags changed';
  if (!sameList(numbersOf(before), numbersOf(after))) return 'numbers changed';
  if (after !== '' && !containsAll(hedgesOf(after), hedgesOf(before))) return 'hedge dropped';
  const restAddress = addressOf(rest);
  if (!containsAll([...addressOf(after), ...restAddress], addressOf(before))) return 'pet name dropped';
  const kept = (after + ' ' + rest).toLowerCase();
  if (namesOf(before).some((n) => !kept.includes(n.toLowerCase()))) return 'name dropped';
  if ((after.match(LAUGH_RE) || []).length > (before.match(LAUGH_RE) || []).length) return 'laugh added';
  if (/[\r\n]/.test(after) && !/[\r\n]/.test(before)) return 'new line break';
  if (after.length > before.length * 1.5 + 40) return 'grew';
  if (newWords(after, before + ' ' + rest) > MAX_NEW_WORDS) return 'new words';
  return '';
}

/* A rewrite says the same thing in other words, so a few new words are normal ("ain't" for "isn't",
 * "reckon"); a handful of new content words means it added something ("and honestly? Respect"). */
const MAX_NEW_WORDS = 2;
const COMMON = new Set(('that this with from have just like they them then than what when where which while your about would could should there their really also only even still very much more most some because been being into over such kind sort thing things stuff gets getting going gonna wanna gotta know think yeah okay well honestly actually basically pretty little whole part point mean means said says make makes made take takes good real right sure maybe probably usually often other another every each both same different first last next back down here time times people folks somebody someone something anything nothing everything').split(' '));
function newWords(after, source) {
  const have = new Set((String(source).toLowerCase().match(/[a-z][a-z'’]+/g) || []).map((w) => w.replace(/['’]/g, '')));
  const stems = new Set([...have].map((w) => w.slice(0, 5)));
  let n = 0;
  for (const raw of String(after).replace(TAG_RE, ' ').toLowerCase().match(/[a-z][a-z'’]+/g) || []) {
    const w = raw.replace(/['’]/g, '');
    if (w.length < 4 || COMMON.has(w) || have.has(w) || stems.has(w.slice(0, 5))) continue;
    n++;
  }
  return n;
}

function applyEdits(text, edits, debugEdits = false) {
  const spans = protectedRanges(text);
  const accepted = [], rejected = [];
  for (const e of Array.isArray(edits) ? edits.slice(0, MAX_EDITS) : []) {
    const before = typeof e?.before === 'string' ? e.before : '';
    let after = typeof e?.after === 'string' ? e.after.trim() : null;
    // A clause cut from the end of a sentence must not leave it ending on a comma.
    const end = before.trim().match(/[.!?…]["”’']?$/);
    if (after && end && /[,;:—–-]$/.test(after)) after = after.replace(/\s*[,;:—–-]$/, end[0]);
    const kind = String(e?.kind || '').toLowerCase();
    if (!before || after === null || before === after || before.trim() === after) continue;
    const at = text.indexOf(before);
    if (at < 0 || text.indexOf(before, at + 1) >= 0) { rejected.push({ kind, why: 'not found once' }); continue; }
    const span = [at, at + before.length];
    if (spans.some((p) => overlaps(p, span))) { rejected.push({ kind, why: 'protected' }); continue; }
    if (accepted.some((a) => overlaps([a.start, a.end], span))) { rejected.push({ kind, why: 'overlap' }); continue; }
    const why = checkEdit(before, after, kind, text.slice(0, span[0]) + ' ' + text.slice(span[1]));
    if (why) { rejected.push({ kind, why, ...(debugEdits ? { before, after } : {}) }); continue; }
    accepted.push({ start: span[0], end: span[1], before, after, kind });
  }
  let out = text;
  for (const a of [...accepted].sort((x, y) => y.start - x.start)) {
    let after = a.after;
    // A deletion takes the space before it too, so no double spaces or blank-led lines remain.
    let start = a.start;
    if (after === '') while (start > 0 && /[ \t]/.test(out[start - 1])) start--;
    // Deleting the closing clause of a sentence ("..., and that's about the size of it.") must
    // not leave the sentence ending on the comma before it.
    const end = a.before.trim().match(/[.!?…]["”’']?$/);
    if (after === '' && end && start > 0 && /[,;:—–-]/.test(out[start - 1])) {
      start--;
      after = end[0];
    }
    out = out.slice(0, start) + after + out.slice(a.end);
  }
  out = out.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: out, accepted, rejected };
}

function finalCheck(original, edited) {
  if (!edited.trim()) return 'empty';
  if (edited.trim().length < original.trim().length * 0.55) return 'cut too much';
  if (!sameList(tagsOf(original), tagsOf(edited))) return 'tags changed';
  if (!sameList(numbersOf(original), numbersOf(edited))) return 'numbers changed';
  return '';
}

/* MiMo Flash speed swings by host and hour (Oct 18 03:38Z, one call at a time: Io Net 10.3 s
 * median, DeepInfra 3.7 s, Makora 1.5 s; an hour earlier Io Net was the fast one at 1.5 s). So a
 * pass asks the first host, and if it has not answered after `hedgeMs` asks the next as well; the
 * first usable answer wins and the others are cancelled. Every host keeps the retention rule. */
async function hedged(complete, req, hosts, timeoutMs, hedgeMs) {
  const list = hosts.length ? hosts : [undefined];
  const controllers = [];
  let settled = false;
  return new Promise((resolve, reject) => {
    let pending = 0, launched = 0, lastError = null;
    const timers = [];
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      controllers.forEach((c) => { try { c.abort(); } catch (_) {} });
      fn(value);
    };
    const launch = () => {
      if (settled || launched >= list.length) return;
      const host = list[launched++];
      const ac = new AbortController();
      controllers.push(ac);
      pending++;
      const body = host ? { ...req, provider: { ...req.provider, order: [host], allow_fallbacks: false } } : req;
      Promise.resolve()
        .then(() => complete(body, timeoutMs, ac.signal))
        .then((result) => {
          pending--;
          const content = result?.choices?.[0]?.message?.content;
          if (typeof content === 'string' && content.trim()) finish(resolve, result);
          else { lastError = new Error('empty'); if (!pending) launched < list.length ? launch() : finish(reject, lastError); }
        }, (error) => {
          pending--;
          lastError = error;
          if (settled) return;
          if (launched < list.length) launch();
          else if (!pending) finish(reject, lastError);
        });
      if (launched < list.length) timers.push(setTimeout(launch, hedgeMs));
    };
    timers.push(setTimeout(() => finish(reject, Object.assign(new Error('timeout'), { name: 'AbortError' })), timeoutMs));
    launch();
  });
}

function parse(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch (_) {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
  return null;
}

/**
 * @param {string} text the finished reply
 * @param {object} body the upstream request (for the persona and the person's last message)
 * @param {{complete:(body:object, timeoutMs:number)=>Promise<any>, model?:string, hosts?:string[],
 *   passes?:number, timeoutMs?:number, budgetMs?:number, env?:object}} opts
 */
async function registerEdit(text, body, opts = {}) {
  const env = opts.env || process.env;
  const started = Date.now();
  if (!on(env)) return { text, status: 'off', passes: [] };
  const skip = eligible(body, text);
  if (skip) return { text, status: 'skipped', reason: skip, passes: [] };
  const model = opts.model || env.KADE_REGISTER_EDIT_MODEL || 'xiaomi/mimo-v2.6-flash';
  const hosts = opts.hosts || (env.KADE_REGISTER_EDIT_HOSTS || 'Makora,Io Net,DeepInfra').split(',').map((h) => h.trim()).filter(Boolean);
  const hedgeMs = opts.hedgeMs || parseInt(env.KADE_REGISTER_EDIT_HEDGE_MS || '', 10) || 1500;
  const passes = opts.passes || passesFor(env);
  const timeoutMs = opts.timeoutMs || parseInt(env.KADE_REGISTER_EDIT_TIMEOUT_MS || '', 10) || 6000;
  const budgetMs = opts.budgetMs || parseInt(env.KADE_REGISTER_EDIT_BUDGET_MS || '', 10) || 9000;
  const { name, voice } = characterOf(body);
  const person = lastUserText(body).replace(/^\[Message source:[^\]]*\]\s*/, '').slice(-1500);
  let current = text;
  const log = [];
  let usage = null;
  for (let p = 0; p < passes; p++) {
    const left = budgetMs - (Date.now() - started);
    if (left < 1200) { log.push({ pass: p + 1, status: 'no time' }); break; }
    const t0 = Date.now();
    const req = {
      model,
      temperature: 0.3,
      max_tokens: 1500,
      reasoning: { effort: 'none', enabled: false },
      response_format: { type: 'json_object' },
      provider: { order: hosts, allow_fallbacks: true, zdr: true, data_collection: 'deny' },
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: `Character: ${name || 'the character in this chat'}\n\nHow the character's own instructions describe their talk:\n${voice || '(not given)'}\n\nThe person said:\n${person}\n\nThe reply to edit:\n<<<\n${current}\n>>>` },
      ],
    };
    let result;
    try {
      result = await hedged(opts.complete, req, hosts, Math.min(timeoutMs, left), hedgeMs);
    } catch (error) {
      log.push({ pass: p + 1, status: 'failed', errorType: error?.status || error?.name || 'error', ms: Date.now() - t0 });
      break;
    }
    usage = result?.usage || usage;
    const choice = result?.choices?.[0];
    if (choice?.finish_reason === 'length' || choice?.finish_reason === 'content_filter') {
      log.push({ pass: p + 1, status: choice.finish_reason, ms: Date.now() - t0 });
      break;
    }
    const parsed = parse(choice?.message?.content);
    if (!parsed || !Array.isArray(parsed.edits)) { log.push({ pass: p + 1, status: 'invalid_json', ms: Date.now() - t0 }); break; }
    const applied = applyEdits(current, parsed.edits, Boolean(opts.debug));
    const bad = finalCheck(current, applied.text);
    if (bad) { log.push({ pass: p + 1, status: 'refused', reason: bad, ms: Date.now() - t0 }); break; }
    log.push({ pass: p + 1, status: applied.accepted.length ? 'edited' : 'kept', ms: Date.now() - t0,
      kinds: applied.accepted.map((a) => a.kind), rejected: applied.rejected.map((r) => r.why), host: result?.provider,
      ...(opts.debug ? { rejectedEdits: applied.rejected, acceptedEdits: applied.accepted } : {}) });
    if (!applied.accepted.length) break;
    current = applied.text;
  }
  const bad = current === text ? '' : finalCheck(text, current);
  if (bad) return { text, status: 'refused', reason: bad, passes: log, name, elapsedMs: Date.now() - started, usage };
  return { text: current, status: current === text ? 'kept' : 'edited', passes: log, name, elapsedMs: Date.now() - started, usage };
}

module.exports = { registerEdit, characterOf, eligible, applyEdits, checkEdit, finalCheck, SYSTEM, WRITING_RE, on, passesFor };
