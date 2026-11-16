// Word replacement, ported from happy-app/sources/voice/dictationDictionary.ts so the
// watch applies the user's Happy dictation dictionary exactly the way the app does.
// Entries are { word, replacement }; entries without a replacement are vocabulary-only.

const normalizePhrase = (text) => text.trim().replace(/\s+/gu, ' ');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Apply corrections once, without rewriting parts of words or cascading replacements. */
export function applyDictionary(text, dictionary) {
  const byPhrase = new Map();
  for (const entry of dictionary) {
    const word = normalizePhrase(entry.word ?? '');
    if (!word || entry.replacement === undefined) continue;
    const key = word.toLowerCase();
    const entries = byPhrase.get(key) ?? [];
    entries.push({ word, replacement: entry.replacement });
    byPhrase.set(key, entries);
  }
  if (byPhrase.size === 0) return text;

  const alternatives = [...byPhrase.keys()]
    .sort((a, b) => b.length - a.length)
    .map((phrase) => phrase.split(' ').map(escapeRegExp).join('\\s+'));
  const boundary = '[^\\p{L}\\p{N}\\p{M}_]';
  const pattern = new RegExp(`(^|${boundary})(${alternatives.join('|')})(?=$|${boundary})`, 'giu');
  return text.replace(pattern, (_match, prefix, phrase) => {
    const normalized = normalizePhrase(phrase);
    const entries = byPhrase.get(normalized.toLowerCase());
    // Prefer an exact-case rule; otherwise the first saved variant wins.
    const entry = entries?.find((candidate) => candidate.word === normalized) ?? entries?.[0];
    return prefix + (entry?.replacement ?? phrase);
  });
}
