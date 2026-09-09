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

function voicePerformanceNoteFor(body) {
  if (process.env.KADE_TTS_PERFORMANCE_NOTE === '0') return '';
  if (body?.response_format && body.response_format.type !== 'text') return '';
  return VOICE_PERFORMANCE_NOTE;
}
module.exports = { VOICE_PERFORMANCE_NOTE, voicePerformanceNoteFor };
