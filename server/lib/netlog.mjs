// Failed requests, so a "No connection" on the watch can be explained afterwards. Two sources:
// - the watch (1.0.46+) keeps a record of each request that failed (the real error, the network it
//   used, phone reachability, app state, try number, how long it ran, bytes sent) and posts them to
//   POST /netlog with the next request that works;
// - the server writes one itself when a /dictate upload is cut off before its body arrived.
// Stored in the net_failures table of dictations.db; shown by `node server/log.mjs` and /log.

const ID = /^[A-Za-z0-9-]{8,80}$/;
const str = (v, max) => (typeof v === 'string' && v.length ? v.slice(0, max) : null);
const int = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' && typeof v !== 'boolean' ? Math.round(Number(v)) : null);
const bool = (v) => (typeof v === 'boolean' ? (v ? 1 : 0) : null);
// Watch times are epoch ms. Anything before 2026 or more than a day ahead is a bad clock or garbage.
const time = (v) => {
  const ms = int(v);
  return ms && ms > Date.UTC(2026, 0, 1) && ms < Date.now() + 86_400_000 ? new Date(ms).toISOString() : null;
};

/** One record from the watch as a table row, or null if it can't be used. */
export function watchFailureRow(raw, { version = null, receivedAt = new Date().toISOString() } = {}) {
  if (!raw || typeof raw !== 'object' || !ID.test(String(raw.id || ''))) return null;
  const at = time(raw.at);
  if (!at) return null;
  const extra = {};
  for (const k of ['protocol', 'unavailable', 'stream', 'remoteAddress', 'expensive', 'constrained', 'proxied', 'reused', 'connectMs', 'sendBodyMs', 'waitMs']) {
    if (raw[k] !== undefined && raw[k] !== null) extra[k] = typeof raw[k] === 'string' ? raw[k].slice(0, 80) : raw[k];
  }
  return {
    id: `w-${raw.id}`, source: 'watch', at, last_at: time(raw.lastAt), count: Math.max(1, int(raw.count) ?? 1),
    route: str(raw.route, 20), clip_id: str(raw.clipId, 64),
    code: int(raw.code), domain: str(raw.domain, 60), underlying: str(raw.underlying, 120),
    reason: str(raw.reason, 60), detail: str(raw.detail, 200), http_status: int(raw.status),
    ran_ms: int(raw.ranMs), bytes_sent: int(raw.bytesSent), bytes_expected: int(raw.bytesExpected),
    attempt: int(raw.attempt), network: str(raw.network, 20), local_address: str(raw.localAddress, 60),
    phone: bool(raw.phoneReachable), app_state: str(raw.app, 40),
    app_version: str(raw.version, 40) ?? str(version, 40), received_at: receivedAt,
    extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
  };
}

/** The server's own record of a /dictate upload the watch (or the network) cut off. */
export function serverAbortRow({ clipId, startedAt, received, expected, error, version }) {
  const at = new Date(startedAt).toISOString();
  return {
    id: `s-${clipId || 'noclip'}-${startedAt}`, source: 'server', at, last_at: new Date().toISOString(), count: 1,
    route: 'dictate', clip_id: clipId || null, code: null, domain: null, underlying: null,
    reason: 'Upload cut off', detail: String(error || 'aborted').slice(0, 200), http_status: null,
    ran_ms: Date.now() - startedAt, bytes_sent: received ?? null, bytes_expected: int(expected),
    attempt: null, network: null, local_address: null, phone: null, app_state: null,
    app_version: str(version, 40), received_at: new Date().toISOString(), extra: null,
  };
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** One line saying what failed and everything known about why. */
export function describeFailure(r, fmtTime = (iso) => iso) {
  const parts = [];
  if (r.source === 'server') {
    parts.push(`server: /dictate upload cut off${r.clip_id ? ` (clip ${r.clip_id.slice(0, 8)})` : ''}`);
  } else {
    parts.push(`watch: /${r.route ?? '?'}${r.clip_id ? ` clip ${r.clip_id.slice(0, 8)}` : ''} failed: ${r.reason ?? 'unknown'}`);
    // An HTTP failure's reason already names the status.
    const code = !r.http_status && r.code !== null && r.code !== undefined ? `${r.domain ?? ''} ${r.code}`.trim() : null;
    if (code || r.underlying) parts[0] += ` (${[code, r.underlying].filter(Boolean).join('; ')})`;
  }
  if (r.attempt) parts.push(`try ${r.attempt}`);
  if (r.ran_ms !== null && r.ran_ms !== undefined) parts.push(`ran ${(r.ran_ms / 1000).toFixed(1)} s`);
  if (r.bytes_sent !== null && r.bytes_sent !== undefined && (r.route === 'dictate' || r.bytes_sent > 0)) parts.push(r.source === 'server' ? `got ${kb(r.bytes_sent)}${r.bytes_expected ? ` of ${kb(r.bytes_expected)}` : ''}` : `sent ${kb(r.bytes_sent)}${r.bytes_expected > 0 ? ` of ${kb(r.bytes_expected)}` : ''}`);
  if (r.network) parts.push(r.network === 'unknown' ? 'no link made' : r.network);
  if (r.phone !== null && r.phone !== undefined) parts.push(r.phone ? 'phone reachable' : 'phone not reachable');
  if (r.app_state) parts.push(`app ${r.app_state}`);
  if (r.count > 1) parts.push(`x${r.count}${r.last_at ? ` until ${fmtTime(r.last_at)}` : ''}`);
  if (r.app_version) parts.push(r.app_version);
  return parts.join(', ');
}

export function failureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS net_failures (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,            -- watch | server
    at TEXT NOT NULL,                -- when the request started (watch clock for watch rows)
    last_at TEXT, count INTEGER,     -- the same failure repeating (polls) is one row
    route TEXT, clip_id TEXT,
    code INTEGER, domain TEXT, underlying TEXT, reason TEXT, detail TEXT, http_status INTEGER,
    ran_ms INTEGER, bytes_sent INTEGER, bytes_expected INTEGER, attempt INTEGER,
    network TEXT, local_address TEXT, phone INTEGER, app_state TEXT, app_version TEXT,
    received_at TEXT, extra TEXT
  )`);
  db.exec(`CREATE INDEX IF NOT EXISTS net_failures_at ON net_failures(at)`);
  const cols = ['id', 'source', 'at', 'last_at', 'count', 'route', 'clip_id', 'code', 'domain', 'underlying', 'reason', 'detail', 'http_status',
    'ran_ms', 'bytes_sent', 'bytes_expected', 'attempt', 'network', 'local_address', 'phone', 'app_state', 'app_version', 'received_at', 'extra'];
  const insert = db.prepare(`INSERT OR IGNORE INTO net_failures (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`);
  return {
    addFailure(row) { return insert.run(...cols.map((c) => row[c] ?? null)).changes; },
    failures({ since = null, limit = 200 } = {}) {
      return since
        ? db.prepare(`SELECT * FROM net_failures WHERE at >= ? ORDER BY at DESC LIMIT ?`).all(since, limit)
        : db.prepare(`SELECT * FROM net_failures ORDER BY at DESC LIMIT ?`).all(limit);
    },
  };
}
