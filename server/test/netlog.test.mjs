import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStore } from '../lib/store.mjs';
import { describeFailure, serverAbortRow, watchFailureRow } from '../lib/netlog.mjs';

const store = () => openStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wd-netlog-')), 'd.db'));
const at = Date.UTC(2026, 10, 13, 0, 5, 12);

const sample = {
  id: 'A1B2C3D4-0000-1111-2222-333344445555', route: 'dictate', clipId: 'cb55271a-9f8c-48d5-9fe6-00d45cfdac62',
  at, lastAt: at, count: 1, code: -1001, domain: 'NSURLErrorDomain', underlying: 'kCFErrorDomainCFNetwork -1001',
  reason: 'Timed out', detail: 'The request timed out.', ranMs: 60123, bytesSent: 131072, bytesExpected: 524288,
  attempt: 2, network: 'not-cellular', localAddress: '192.168.1.40', phoneReachable: false, app: 'background',
  protocol: 'h2', version: '1.0.46 (2611130100)',
};

test('a watch record is stored once, and resending it adds nothing', () => {
  const s = store();
  const row = watchFailureRow(sample);
  assert.equal(s.addFailure(row), 1);
  assert.equal(s.addFailure(watchFailureRow(sample)), 0);
  const [got] = s.failures();
  assert.equal(got.reason, 'Timed out');
  assert.equal(got.code, -1001);
  assert.equal(got.phone, 0);
  assert.equal(got.at, new Date(at).toISOString());
  assert.equal(JSON.parse(got.extra).protocol, 'h2');
});

test('records without an id or a sane time are dropped; junk fields are ignored', () => {
  assert.equal(watchFailureRow({ ...sample, id: 'x' }), null);
  assert.equal(watchFailureRow({ ...sample, at: 5 }), null);
  assert.equal(watchFailureRow(null), null);
  const r = watchFailureRow({ ...sample, code: 'nope', phoneReachable: 'yes', route: 'x'.repeat(100) });
  assert.equal(r.code, null);
  assert.equal(r.phone, null);
  assert.equal(r.route.length, 20);
});

test('the log line says what failed and why', () => {
  const line = describeFailure(watchFailureRow(sample));
  assert.match(line, /watch: \/dictate clip cb55271a failed: Timed out \(NSURLErrorDomain -1001; kCFErrorDomainCFNetwork -1001\)/);
  assert.match(line, /try 2, ran 60\.1 s, sent 128 KB of 512 KB, not-cellular, phone not reachable, app background/);
  const repeated = describeFailure(watchFailureRow({ ...sample, route: 'history', clipId: null, bytesSent: 0, bytesExpected: 0, count: 7, lastAt: at + 600_000 }), () => '7:15');
  assert.match(repeated, /x7 until 7:15/);
  const http = describeFailure(watchFailureRow({ ...sample, code: null, underlying: null, status: 502, reason: 'Server error 502' }));
  assert.match(http, /failed: Server error 502, try 2/);
  assert.doesNotMatch(repeated, /sent/);   // a GET sends nothing worth saying
});

test('an upload cut off on the server side gets its own row', () => {
  const s = store();
  const row = serverAbortRow({ clipId: 'clip-0001', startedAt: Date.now() - 4000, received: 65536, expected: '300000', error: 'aborted', version: '1.0.44 (1)' });
  s.addFailure(row);
  const [got] = s.failures();
  assert.equal(got.source, 'server');
  assert.ok(got.ran_ms >= 4000);
  assert.match(describeFailure(got), /server: \/dictate upload cut off \(clip clip-000\), ran 4\.\d s, got 64 KB of 293 KB/);
});

test('failures can be read from a time on', () => {
  const s = store();
  s.addFailure(watchFailureRow({ ...sample, id: 'AAAAAAAA-1', at: at - 3_600_000 }));
  s.addFailure(watchFailureRow({ ...sample, id: 'AAAAAAAA-2', at }));
  assert.deepEqual(s.failures({ since: new Date(at - 60_000).toISOString() }).map((r) => r.id), ['w-AAAAAAAA-2']);
});
