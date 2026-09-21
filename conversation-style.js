'use strict';

// These broad structures also occur in ordinary corrections and jokes.
// Keep observing them, but don't pay to rewrite a reply on this evidence alone.
const OBSERVE_ONLY = new Set(['reframe_bare', 'isnt_reframe']);
function conversationalRewriteMatches(matches) {
  if (process.env.KADE_CONVERSATION_STYLE_OBSERVE === '0') return matches;
  return matches.filter(match => !OBSERVE_ONLY.has(match.pattern));
}
module.exports = { conversationalRewriteMatches };
