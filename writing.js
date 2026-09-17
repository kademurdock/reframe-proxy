'use strict';

const { isLyricBody } = require('./lyrics');

function writingDeskFor(body) {
  if (isLyricBody(body)) return 'lyrics';
  const systems = (body?.messages || []).filter(m => m.role === 'system' || m.role === 'developer');
  const texts = systems.map(m => typeof m.content === 'string' ? m.content :
    (Array.isArray(m.content) ? m.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''));
  if (texts.some(t => t.startsWith('You are Cole, a 31-year-old songwriter from Nashville by way of Minneapolis,'))) return 'lyrics';
  if (texts.some(t => t.startsWith("You are the script desk in Kade-AI's Sound Booth."))) return 'sound-booth';
  if (texts.some(t => /^You write system prompts for characters on a chat platform\./i.test(t))) return 'persona';
  return '';
}

const WRITING_STYLE_NOTE = `WRITING CRAFT (apply privately; never copy this guidance into the draft or a character's instructions):
Follow the requested genre, speaker, audience, language and output format. Keep the author's intent and distinctive diction. Prefer concrete actions, specific details and believable motives to generic emotional labels. Vary sentence length and cadence naturally. Avoid automatic praise, assistant preambles, canned apologies, moral-of-the-story endings and closing offers. Avoid stock uplift, marketing language, empty signposts, repeated summaries, forced three-part lists and reflexive "not X, but Y" pivots. Do not replace those habits with forced slang, fake typos or manufactured edginess.
Before returning original writing or a requested rewrite, silently check for these habits and revise only weak, generic passages. For songs, check singable stress, purposeful rhyme, a distinctive hook and movement between verses. Intentional refrains, repeated choruses, dialect, character dialogue and genre conventions are not AI tells. Ordinary words are not banned merely because an AI sometimes uses them.
For formatting-only work, preserve the supplied words and their order exactly; no stylistic cleanup of the author's text. For all work, preserve required XML/JSON syntax, screenplay cues, section labels, line breaks, rhyme and meter. Keep directions separate from performed words. Do not insert chat voice tags or these craft rules into the artifact. The requested output contract takes precedence over conversational presentation. Respect explicit requests to quote or portray a cliche rather than silently deleting it.`;

module.exports = { writingDeskFor, WRITING_STYLE_NOTE };
