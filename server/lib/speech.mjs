// Spoken replies: the chat's answer to a watch note, read aloud. Speech comes from the
// Happy relay's /v1/tts, in the voice the account picked (the "ElevenLabs voice" toggle,
// shared with the app's play button and stored on the relay).

/** Markdown to plain speakable prose: no code, tables, URLs or markup (a short reply
 *  version of the app's speechTextFromMarkdown). */
export function speakable(markdown) {
  return String(markdown ?? '')
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/gi, ' ')       // system tags
    .replace(/```[\s\S]*?```/g, ' ')                       // code blocks
    .split('\n').filter((l) => !/^\s*\|/.test(l)).join('\n') // table rows
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')            // links and images: keep the label
    .replace(/https?:\/\/\S+/g, ' ')                       // bare URLs
    .replace(/`([^`]*)`/g, '$1')                           // inline code
    .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/gm, '') // headings, quotes, list markers
    .replace(/[*_~]+/g, '')                                // emphasis
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** MP3 for `text` from the relay, or null on failure. */
export async function synthesize(relayUrl, token, text, { timeoutMs = 20000 } = {}) {
  try {
    const res = await fetch(`${relayUrl}/v1/tts`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** The account's read-aloud voice ('elevenlabs' or 'deepgram'), shared with the Claudeputer
 *  app's play button; null when the relay can't say. */
export async function voiceSetting(relayUrl, token) {
  try {
    const res = await fetch(`${relayUrl}/v1/tts/settings`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) });
    return res.ok ? (await res.json()).provider : null;
  } catch {
    return null;
  }
}

export async function setVoiceSetting(relayUrl, token, provider) {
  const res = await fetch(`${relayUrl}/v1/tts/settings`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`relay ${res.status}`);
}

/** Chats in Claudeputer's /voice mode (kept on the relay by the app), or [] if unknown. */
export async function voiceModeSessions(relayUrl, token) {
  try {
    const res = await fetch(`${relayUrl}/v1/tts/voice-mode`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    return res.ok ? ((await res.json()).sessions ?? []) : [];
  } catch {
    return [];
  }
}
