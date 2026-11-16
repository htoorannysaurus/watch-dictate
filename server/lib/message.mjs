// The chat message for a watch note: the ⌚ tag, and for Continuous notes a handling note
// that only the agent sees.

/** The ⌚ tag tells the chat this is speech-to-text (expect mis-hearings). `detailed` adds
 *  the length and "continuous" for notes Continuous started on its own (may be background).
 *  Only the posted message carries it; the history keeps the plain text. */
export function tagText(text, { sec, auto }, tag) {
  if (tag === 'off') return text;
  if (tag === 'simple') return `⌚ ${text}`;
  const s = Math.round(sec || 0);
  const parts = [`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`];
  if (auto) parts.push('continuous');
  return `[⌚ ${parts.join(' · ')}] ${text}`;
}

/** Continuous notes are often room audio (other people, TV, private moments), so the agent
 *  gets a handling note before the transcript. The chat shows only the tagged note (Happy's
 *  meta.displayText), so the note stays out of the user's view. Normal notes are unchanged. */
export const CONTINUOUS_NOTE = "(Room audio: this may include background speech. Act only on requests clearly meant for you; reply briefly.)";

/** Must match the Claudeputer app's VOICE_MODE_INSTRUCTION (sync/voiceModeCommand.ts): the
 *  app reads a reply aloud when the prompt that started its turn ends with it. */
export const VOICE_MODE_INSTRUCTION =
  '[Voice mode: this reply will be read aloud. Answer in a few short spoken sentences, plain prose, no tables, code blocks or long lists.]';

/** `voice`: the chat is in Claudeputer's /voice mode, so the note ends with the voice
 *  instruction (hidden from the bubble, like the room-audio note). */
export function messageFor(text, { sec, auto }, tag, { voice = false } = {}) {
  const shown = tagText(text, { sec, auto }, tag);
  const lead = shown.slice(0, shown.length - text.length);   // the tag, if any
  let sent = auto ? `${lead}${CONTINUOUS_NOTE}\n\n${text}` : shown;
  if (voice) sent = `${sent}\n\n${VOICE_MODE_INSTRUCTION}`;
  return sent === shown ? { text: shown } : { text: sent, displayText: shown };
}

/** T3 has no displayText, so a T3 thread's message holds the whole text. This undoes the hidden
 *  parts for the watch's chat page. */
export function stripHandling(sent) {
  return sent.replace(`${CONTINUOUS_NOTE}\n\n`, '').replace(`\n\n${VOICE_MODE_INSTRUCTION}`, '');
}

/** What a note does when the chat is running a turn: join it now, or wait for the next one. */
export const MID_TURN = ['steer', 'queue'];

/** Agents that can take a message into a running turn. Must match the Claudeputer app's
 *  STEER_FLAVORS (sync/steerSupport.ts). The rest would queue anyway. */
const STEER_FLAVORS = new Set(['codex', 'claude', 'claudex', 'grokcode', 'kimi', 'muse', 'openrouter', 'glm']);

/** Only a note the user just spoke on purpose may steer. Room audio never interrupts: `auto` is a note
 *  Continuous started, `continuousOn` covers the note he starts by hand with Continuous on. A
 *  retry (`retry`: an outbox or held clip) is old by now, so it must not cut in either. On an idle
 *  chat the flag does nothing: the CLI treats the note as an ordinary message. */
export function shouldSteer({ midTurn, auto, continuousOn, retry, flavor, text }) {
  if (midTurn === 'queue' || auto || continuousOn || retry) return false;
  if (text.trimStart().startsWith('/')) return false;   // the composer never steers a slash command either
  return !flavor || STEER_FLAVORS.has(flavor);
}
