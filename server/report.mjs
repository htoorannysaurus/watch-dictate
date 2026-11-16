#!/usr/bin/env node
// Latency report from ~/.local/share/watch-dictate/dictations.jsonl.
//   node report.mjs [--since 2026-10-24]
// "release -> sent" is measured on the watch (one clock): finger up until the server
// confirms the message is stored in the chat. The push to a listening client lands a
// few ms after that, shown separately.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(process.env.WATCH_DICTATE_DATA || path.join(os.homedir(), '.local/share/watch-dictate'), 'dictations.jsonl');
const since = process.argv.includes('--since') ? process.argv[process.argv.indexOf('--since') + 1] : '';
const rows = fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.at >= since)
  : [];
const dictations = new Map(rows.filter((r) => r.type === 'dictation').map((r) => [r.clipId, r]));
const timings = rows.filter((r) => r.type === 'watch-timing' && dictations.has(r.clipId));

const pct = (xs, p) => {
  if (!xs.length) return '-';
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const line = (label, xs) => console.log(`${label.padEnd(30)} n=${String(xs.length).padEnd(4)} p50=${String(pct(xs, 50)).padEnd(6)} p90=${String(pct(xs, 90)).padEnd(6)} max=${xs.length ? Math.max(...xs) : '-'}`);

console.log(`${dictations.size} dictations, ${timings.length} with watch timings${since ? ` since ${since}` : ''}\n(all values ms)`);
line('release -> sent (watch)', timings.map((t) => t.releaseToAckMs));
line('  upload + reply (watch)', timings.map((t) => t.requestMs));
line('  server total', [...dictations.values()].filter((d) => d.serverMs).map((d) => d.serverMs));
line('    decode', [...dictations.values()].map((d) => d.decodeMs));
line('    transcribe', [...dictations.values()].map((d) => d.sttMs));
line('    post to Happy', [...dictations.values()].filter((d) => d.postMs != null).map((d) => d.postMs));
line('  network (request - server)', timings.map((t) => t.requestMs - (dictations.get(t.clipId).serverMs || 0)));
line('push after post', [...dictations.values()].filter((d) => d.pushAfterPostMs != null).map((d) => d.pushAfterPostMs));

const byNet = {};
for (const t of timings) (byNet[t.network] ??= []).push(t.releaseToAckMs);
for (const [net, xs] of Object.entries(byNet)) line(`release -> sent on ${net}`, xs);
const short = timings.filter((t) => dictations.get(t.clipId).audioSec <= 20).map((t) => t.releaseToAckMs);
const long = timings.filter((t) => dictations.get(t.clipId).audioSec > 20).map((t) => t.releaseToAckMs);
line('release -> sent, notes <= 20 s', short);
line('release -> sent, notes > 20 s', long);

// Watch 1.0.39+: where the upload's time goes and over what link.
const links = rows.filter((r) => r.type === 'watch-timing' && r.sendBodyMs != null);
if (links.length) {
  console.log('\nUpload (ms)');
  line('connect', links.filter((t) => !t.reused).map((t) => t.connectMs));
  line('send audio', links.map((t) => t.sendBodyMs));
  line('wait for reply', links.map((t) => t.waitMs));
  const count = (f) => { const c = {}; for (const t of links) c[f(t)] = (c[f(t)] || 0) + 1; return JSON.stringify(c); };
  console.log(`  link: ${count((t) => t.network)}; iPhone reachable: ${count((t) => t.phoneReachable)}; proxied: ${count((t) => t.proxied)}; expensive: ${count((t) => t.expensive)}`);
  console.log(`  connection reused: ${count((t) => t.reused)}; protocol: ${count((t) => t.protocol)}; local address: ${count((t) => t.localAddress)}`);
}
