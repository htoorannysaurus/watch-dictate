// Notes the server owns. A long note is answered "accepted" (202) while it is still being
// transcribed, and the watch then deletes its copy. From that moment the audio and where it was
// going are kept here, on disk, until the note has reached its chat. A failure or a restart in
// between leaves the record, and the server works through what is left.

import fs from 'node:fs';
import path from 'node:path';

/** Write the whole file or none of it: a crash mid-write never leaves half a file. */
export function writeAtomic(file, data, mode = 0o600) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data, { mode });
  fs.renameSync(tmp, file);
}

/** Minutes to wait before try number `tries + 1`: 1, 2, 4 ... up to an hour. */
export const retryDelayMs = (tries) => Math.min(60_000 * 2 ** Math.max(0, tries - 1), 60 * 60_000);

export class AcceptedNotes {
  /** `maxTries`: after this many failed tries the note is set aside (kept on disk, not retried). */
  constructor(dir, { maxTries = 20 } = {}) {
    this.dir = dir;
    this.maxTries = maxTries;
  }

  #json(clipId) { return path.join(this.dir, `${clipId}.json`); }
  #audio(clipId) { return path.join(this.dir, `${clipId}.m4a`); }

  has(clipId) { return fs.existsSync(this.#json(clipId)); }

  /** Audio first, then the record: a record always has its audio. */
  save(clipId, audio, meta) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeAtomic(this.#audio(clipId), audio);
    writeAtomic(this.#json(clipId), JSON.stringify({ clipId, meta, tries: 0, nextAt: 0, at: new Date().toISOString() }));
  }

  /** The note reached its chat (or is kept elsewhere): nothing more to do. */
  done(clipId) {
    fs.rmSync(this.#json(clipId), { force: true });
    fs.rmSync(this.#audio(clipId), { force: true });
  }

  audio(clipId) { return fs.readFileSync(this.#audio(clipId)); }

  /** Records due for another try at `now`. A record that can't be read is set aside, not fatal. */
  due(now = Date.now()) {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(this.dir).filter((n) => n.endsWith('.json')).sort()) {
      const file = path.join(this.dir, name);
      let record;
      try {
        record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!record?.clipId || !fs.existsSync(this.#audio(record.clipId))) throw new Error('incomplete');
      } catch {
        fs.renameSync(file, `${file}.bad`);
        continue;
      }
      if ((record.nextAt ?? 0) <= now) out.push(record);
    }
    return out;
  }

  /** A try failed. Returns false when the note has used up its tries and was set aside. */
  failed(clipId, now = Date.now()) {
    const file = this.#json(clipId);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    record.tries = (record.tries ?? 0) + 1;
    if (record.tries >= this.maxTries) {
      writeAtomic(file, JSON.stringify(record));
      fs.renameSync(file, `${file}.gave-up`);   // the audio stays beside it
      return false;
    }
    record.nextAt = now + retryDelayMs(record.tries);
    writeAtomic(file, JSON.stringify(record));
    return true;
  }
}

/** The held notes in `dir`, oldest first. A file that can't be read is set aside so it never
 *  blocks the others. */
export function readHeldNotes(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const note = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!note?.clipId || typeof note.text !== 'string') throw new Error('incomplete');
      out.push({ file, note });
    } catch {
      fs.renameSync(file, `${file}.bad`);
    }
  }
  return out;
}
