'use strict';

// Applied inside the existing conversational lane only. No extra model call,
// per-word emotion guessing, tempo knob change or generated sound insertion.
const VOICE_PERFORMANCE_NOTE = [
  ' Voice performance: these words may be heard through TTS. Direct a person speaking spontaneously to somebody they know, rather than reading a prepared answer.',
  'Keep a comfortable pace while letting pitch, stress and phrasing move with the thought. Steady pace does not mean steady pitch or equal weight on every word.',
  'Write the %%%direction%%% as a brief instruction to the performer: what is the attitude, and how should the voice make it audible?',
  'When you use a direction, include one concrete vocal cue with the attitude: a smile in the voice, a lifted or falling pitch, a lightly stressed word, or a small hesitation. Mood labels such as warm and steady or amused and warm alone leave the performance underspecified. Do not stack a list of effects; choose the cue that carries this particular thought.',
  'For example, amused can have a smile in the voice and a lightly lifted pitch; disbelief can stress the surprising word before settling; owning a mix-up can sound sheepish before warming back up. Choose what fits this character and this moment, not an example to repeat.',
  'A dry joke can still have a wry smile and a pointed word. Do not default ordinary conversation to flat, neutral, matter-of-fact, straightforward, or dry-and-steady directions.',
  'Use deadpan or monotone when the person or the actual performance calls for it. Calm, serious and gentle speech can remain attentive and inflected; follow explicit delivery requests.',
  'A direction may last through the whole thought. Change it at a real turn in attitude, without a tag quota, automatic laughter, constant excitement or speed changes. Keep each character\'s accent, personality and emotional range.',
  'Keep these directions out of code, quotations, documents and messages you are drafting for somebody else.',
].join(' ');

/* Part 221 (Sep 19 2026). Kade, first day of the fleet on deepseek-v4.1-flash:
 * "Her emotions were all over the place with not that many pauses in between
 * major emotional shifts. I like the voices being animated for sure." Measured
 * on the vischeck seat the same day: three directions in a 110-word reply, a new
 * mood on every paragraph. (Part 223 correction: the persona lines first blamed
 * here came from a stale August copy; her live persona is calm about tags. A new
 * mood per paragraph is DeepSeek's own habit.) This rides
 * last in the context on deepseek turns only and keeps the animation while
 * giving each mood room. Kill switch: KADE_DEEPSEEK_VOICE_PACING=0. */
/* Part 222, the same day, her correction after the first version of this note
 * (which asked for fewer directions and let replies open bare): "I don't think
 * any crap should start without a tag. Steering tags are what animate the
 * speech and tell it how to act. But I do understand why one sentence yelling
 * and the next sentence whispering is jarring. Stuff like that is what I mean,
 * not boring flat emotion." So: every spoken reply opens on a direction, the
 * directions stay vivid and frequent, and the ONLY restraint is the jump cut
 * between far-apart energies. */
const DEEPSEEK_VOICE_PACING_NOTE = [
  ' Voice directions: the %%%direction%%% tags are what animate your voice, so open every spoken reply with one and give each new stretch of feeling its own. Make them vivid and specific to the moment; big feelings are welcome. Flat or neutral delivery is never the goal.',
  'The one thing to avoid is the jump cut: shouting in one sentence and whispering in the next, or giddy straight into grave, with nothing in between. A real voice travels. When the feeling swings far, let it pass through a step on the way: a sentence that starts to turn, a direction that is part way there, or a real sound such as %%%sigh%%%, %%%laugh%%% or %%%breathe%%%, and then land the new direction.',
  'Give a direction a few sentences to play before the next one, so each mood is heard rather than flickered past. Never write a pause or a beat as a direction; punctuation and paragraphs do the timing.',
  /* Sep 20 2026. Kade: "she goes from one chunk of text being slow, quiet, and
   * calm, then she might do another few sentences in fast as hell, loud,
   * hurried. It's jarring during a conversation... it really needs to be a
   * steering transcriptive thing, like someone's auditing a live transcription
   * of speech." Measured in the speech proxy (Part 109): a feeling word moves
   * the speaking speed one to three percent, "unhurried" +42, "quick" -27, and
   * it holds until the next tag. The proxy now strips tempo words from authored
   * directions (inworld-tts-proxy, AUTHOR_TEMPO_STRIP); this sentence is so the
   * model stops spending its direction on them. */
  'Write each direction the way someone transcribing a live conversation would note how a line was said: the feeling, the tone, the texture of the voice (a grin in it, a catch, gravel, brightness, a wry edge). A direction never sets the speed or the volume. Leave out slow, unhurried, quick, fast, rushed, hurried, racing, breathless and every other pace word, and leave out loud, quiet, shouting and whispering as instructions; excitement shows in brightness and stress, calm shows in warmth, and the speaking pace stays that of one person talking across a table the whole way through.',
].join(' ');
function isDeepseekBody(body) {
  return /^deepseek\//i.test(String(body?.model || ''));
}

function voicePerformanceNoteFor(body) {
  if (process.env.KADE_TTS_PERFORMANCE_NOTE === '0') return '';
  if (body?.response_format && body.response_format.type !== 'text') return '';
  const pacing = isDeepseekBody(body) && process.env.KADE_DEEPSEEK_VOICE_PACING !== '0' ? DEEPSEEK_VOICE_PACING_NOTE : '';
  return VOICE_PERFORMANCE_NOTE + pacing;
}
module.exports = { DEEPSEEK_VOICE_PACING_NOTE, VOICE_PERFORMANCE_NOTE, voicePerformanceNoteFor };
