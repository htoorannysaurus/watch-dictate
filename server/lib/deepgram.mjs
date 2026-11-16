// Deepgram Nova-3 pre-recorded transcription. The clip is sent as-is (AAC); keyterms are
// the replacement words from Happy's dictation dictionary, so names come out right.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENV_FILE = process.env.DEEPGRAM_ENV_FILE || path.join(os.homedir(), '.config/deepgram/owner.env');

function apiKey() {
  const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^DEEPGRAM_OWNER_API_KEY=(.+)$/m);
  if (!m) throw new Error('Deepgram key missing');
  return m[1].trim().replace(/^["']|["']$/g, '');
}

export function keyterms(dictionary) {
  const terms = new Set();
  for (const e of dictionary) {
    const t = (e.replacement || '').trim();
    if (t && t.length <= 30 && /[A-Za-z]/.test(t)) terms.add(t);
  }
  return [...terms].slice(0, 80);
}

export async function deepgramTranscribe(audio, { terms = [], timeoutMs }) {
  const params = new URLSearchParams({ model: 'nova-3', smart_format: 'true' });
  for (const t of terms) params.append('keyterm', t);
  const res = await fetch(`https://api.deepgram.com/v1/listen?${params}`, {
    method: 'POST',
    headers: { Authorization: `Token ${apiKey()}`, 'Content-Type': 'audio/mp4' },
    body: audio,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const d = await res.json();
  return (d.results?.channels?.[0]?.alternatives?.[0]?.transcript || '').trim();
}
