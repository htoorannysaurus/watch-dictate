// The dictation log: one row per clip in SQLite (DATA/dictations.db), written as the clip
// moves through the pipeline. View with `node server/log.mjs` or GET /log.

import { DatabaseSync } from 'node:sqlite';
import { failureTable } from './netlog.mjs';

export function openStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE IF NOT EXISTS dictations (
    clip_id TEXT PRIMARY KEY,
    received_at TEXT NOT NULL,       -- server time the clip arrived (ISO)
    recorded_sec REAL,               -- audio length
    engine TEXT,                     -- deepgram | local (what actually transcribed)
    chat TEXT, session_id TEXT,
    raw TEXT,                        -- transcript as the engine returned it
    corrected TEXT,                  -- after Happy's dictation dictionary
    status TEXT NOT NULL,            -- processing | sent | empty | error
    server_ms INTEGER, stt_ms INTEGER,
    release_to_ack_ms INTEGER,       -- measured on the watch
    network TEXT,
    error TEXT
  )`);
  const have = db.prepare(`PRAGMA table_info(dictations)`).all().map((c) => c.name);
  if (!have.includes('target_kind')) db.exec(`ALTER TABLE dictations ADD COLUMN target_kind TEXT`);   // extra | t3 (older rows: main)
  for (const c of ['reply', 'reply_status', 'reply_at', 'reply_audio_sec', 'auto', 'steer', 'ended_by', 'paused_ms']) if (!have.includes(c)) db.exec(`ALTER TABLE dictations ADD COLUMN ${c} TEXT`);
  const cols = ['reply', 'reply_status', 'reply_at', 'reply_audio_sec', 'auto', 'steer', 'ended_by', 'paused_ms', 'target_kind', 'received_at', 'recorded_sec', 'engine', 'chat', 'session_id', 'raw', 'corrected', 'status',
    'server_ms', 'stt_ms', 'release_to_ack_ms', 'network', 'error'];
  return {
    ...failureTable(db),   // net_failures: failed requests from the watch, and uploads cut off (lib/netlog.mjs)
    start(clipId, fields) {
      db.prepare(`INSERT OR IGNORE INTO dictations (clip_id, received_at, status) VALUES (?, ?, 'processing')`)
        .run(clipId, fields.received_at);
    },
    update(clipId, fields) {
      const keys = Object.keys(fields).filter((k) => cols.includes(k));
      if (!keys.length) return;
      db.prepare(`UPDATE dictations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE clip_id = ?`)
        .run(...keys.map((k) => fields[k] ?? null), clipId);
    },
    get(clipId) {
      return db.prepare(`SELECT * FROM dictations WHERE clip_id = ?`).get(clipId);
    },
    recent(limit = 50) {
      return db.prepare(`SELECT * FROM dictations ORDER BY received_at DESC LIMIT ?`).all(limit);
    },
  };
}
