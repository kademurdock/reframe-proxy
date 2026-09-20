'use strict';

const MARKER = 'LYRIC — SONGWRITER AND CO-WRITER';
/* Sep 20 2026: the Sound Booth song desk's prompt has opened with this line since
 * the fork's Part 217, which matched neither the marker above nor the script
 * desk's opening in writing.js. Its drafts rode the ordinary chat lane: the voice
 * reminder went in, and on the way out the echo guard called the audit's copy of
 * the music direction a user echo and had the rewrite model redo the whole song.
 * One rewrite reworded the READBACK and dropped its label, and the engine sang
 * the description as the last lines of Kade's song. Keep this string identical
 * to musicWritingPrompt in the fork's packages/api/src/music/writing.ts. */
const SONG_DESK = "You are Lyric, working the songwriting desk in Kade-AI's Sound Booth.";

function isLyricBody(body) {
  return (body?.messages || []).some((message) => {
    if (message.role !== 'system' && message.role !== 'developer') return false;
    const content = typeof message.content === 'string' ? message.content :
      (Array.isArray(message.content) ? message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n') : '');
    return content.startsWith(MARKER) || content.startsWith(SONG_DESK);
  });
}

const LYRIC_OUTPUT_NOTE = 'LYRIC OUTPUT: The user is working with a songwriter. For lyrics, verses, hooks, revisions, and production fields, preserve the requested format and line breaks. Do not add chat voice directions, percent-sign tags, reset tags, introductions, commentary, or a closing offer. The songwriting instructions govern these artifacts, including when the shared platform voice guidance asks for a direction. Normal music conversation may use your ordinary voice. Do not call a paid generation tool unless the user asks for audio.';

module.exports = { isLyricBody, LYRIC_OUTPUT_NOTE };
