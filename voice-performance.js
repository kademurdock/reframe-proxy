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
 * mood on every paragraph. Personas written for Grok push hard ("dead quiet to
 * screaming happy in a split second") because Grok half-ignored them; DeepSeek
 * obeys hidden notes literally, so the same words now overshoot. This rides
 * last in the context on deepseek turns only and keeps the animation while
 * giving each mood room. Kill switch: KADE_DEEPSEEK_VOICE_PACING=0. */
const DEEPSEEK_VOICE_PACING_NOTE = [
  ' Voice pacing: a listener needs time to travel with a mood. In an ordinary reply one direction is usual and two is plenty; a third belongs only in a long reply with a third real turn.',
  'Let a direction carry at least three or four sentences before the next one. Keep the voice lively inside a direction through word choice, stress and one real sound such as %%%laugh%%% or %%%sigh%%% rather than by changing directions.',
  'When the feeling truly turns, for example from joking to tender or from angry to calm, earn it out loud: finish the thought, start a new paragraph, and let a short bridging sentence or a real breath such as %%%sigh%%% or %%%breathe%%% come before the new direction, so the change arrives as a shift and not a jump cut. Never write a pause or a beat as a direction; punctuation and paragraphs do the timing.',
  'Neighbouring directions should be within reach of each other in energy unless the moment is a genuine shock. Big swings are still welcome when the conversation itself swings; they are an event, not the rhythm of every reply.',
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
