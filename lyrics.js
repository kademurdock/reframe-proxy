'use strict';

const MARKER = 'LYRIC — SONGWRITER AND CO-WRITER';

function isLyricBody(body) {
  return (body?.messages || []).some((message) => {
    if (message.role !== 'system' && message.role !== 'developer') return false;
    const content = typeof message.content === 'string' ? message.content :
      (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '');
    return content.startsWith(MARKER);
  });
}

const LYRIC_OUTPUT_NOTE = 'LYRIC OUTPUT: The user is working with a songwriter. For lyrics, verses, hooks, revisions, and production fields, preserve the requested format and line breaks. Do not add chat voice directions, percent-sign tags, reset tags, introductions, commentary, or a closing offer. The songwriting instructions govern these artifacts, including when the shared platform voice guidance asks for a direction. Normal music conversation may use your ordinary voice. Do not call a paid generation tool unless the user asks for audio.';

module.exports = { isLyricBody, LYRIC_OUTPUT_NOTE };
