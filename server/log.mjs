#!/usr/bin/env node
// Print the dictation log.   node log.mjs [N]              (default last 20 notes, with failed requests among them)
//                            node log.mjs --failures [N]   (only failed requests, default last 30)
//                            node log.mjs --backfill       (import the older dictations.jsonl rows)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from './lib/store.mjs';
import { describeFailure } from './lib/netlog.mjs';

const DATA = process.env.WATCH_DICTATE_DATA || path.join(os.homedir(), '.local/share/watch-dictate');
const store = openStore(path.join(DATA, 'dictations.db'));

if (process.argv[2] === '--backfill') {
  const timing = {};
  const rows = fs.readFileSync(path.join(DATA, 'dictations.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) if (r.type === 'watch-timing') timing[r.clipId] = r;
  let n = 0;
  for (const r of rows.filter((x) => x.type === 'dictation')) {
    store.start(r.clipId, { received_at: r.at });
    const t = timing[r.clipId] || {};
    store.update(r.clipId, {
      recorded_sec: r.audioSec, engine: r.engine || 'local', chat: r.chat, session_id: r.sessionId, raw: r.raw,
      corrected: r.text, status: r.empty ? 'empty' : 'sent', server_ms: r.serverMs, stt_ms: r.sttMs,
      release_to_ack_ms: t.releaseToAckMs, network: t.network,
    });
    n++;
  }
  console.log(`backfilled ${n} dictations`);
  process.exit(0);
}

const fmt = (iso) => new Date(iso).toLocaleString('en-CA', { hour12: false });
const clock = (iso) => new Date(iso).toLocaleTimeString('en-CA', { hour12: false });
const printFailure = (f) => {
  console.log(`${fmt(f.at)}  FAILED  ${describeFailure(f, clock)}`);
  if (f.detail && f.source === 'watch') console.log(`    ${f.detail}`);
};

if (process.argv[2] === '--failures') {
  for (const f of store.failures({ limit: Number(process.argv[3]) || 30 }).reverse()) printFailure(f);
  process.exit(0);
}

const n = Number(process.argv[2]) || 20;
const notes = store.recent(n);
const failures = store.failures({ since: notes.length === n ? notes.at(-1).received_at : null, limit: 500 });
const all = [...notes.map((r) => ({ at: r.received_at, r })), ...failures.map((f) => ({ at: f.at, f }))].sort((a, b) => a.at.localeCompare(b.at));
for (const { r, f } of all) {
  if (f) { printFailure(f); continue; }
  const when = fmt(r.received_at);
  const send = r.release_to_ack_ms ? `${(r.release_to_ack_ms / 1000).toFixed(1)}s` : '-';
  console.log(`${when}  ${String(r.recorded_sec ?? '?').padStart(6)}s  ${(r.engine ?? '-').padEnd(8)} ${r.status.padEnd(7)} send ${send.padEnd(6)} ${r.chat ?? ''}${r.target_kind === 't3' ? ' (T3)' : ''}`);
  console.log(`    ${r.corrected || r.raw || ''}`);
  if (r.raw && r.corrected && r.raw !== r.corrected) console.log(`    heard: ${r.raw}`);
  if (r.ended_by || r.paused_ms || r.steer === '1') console.log(`    ${[r.ended_by && `ended by ${r.ended_by}`, r.paused_ms && `mic paused ${(r.paused_ms / 1000).toFixed(1)} s`, r.steer === '1' && 'steer'].filter(Boolean).join(', ')}`);
  if (r.error) console.log(`    error: ${r.error}`);
}
