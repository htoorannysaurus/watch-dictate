import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { T3, T3Error, isRoomAudio, isT3Wire, parseT3Target, t3Binary, t3Flag, t3HistoryItems, t3ThreadRows, waitForT3Reply } from '../lib/t3.mjs';
import { CONTINUOUS_NOTE, VOICE_MODE_INSTRUCTION, messageFor, stripHandling } from '../lib/message.mjs';

const at = '2026-11-02T20:00:00.000Z';
const user = (position, text, extra = {}) => ({ type: 'user_message', position, text, runId: `r${position}`, updatedAt: at, ...extra });
const agent = (position, text, runId) => ({ type: 'assistant_message', position, text, runId, updatedAt: at });

test('continuous note: same text as a Happy chat gets, tag first, and the chat page hides the note', () => {
  const m = messageFor('Dentist at noon', { sec: 12, auto: true }, 'detailed');
  assert.equal(m.text, `[⌚ 0:12 · continuous] ${CONTINUOUS_NOTE}\n\nDentist at noon`);
  assert.equal(stripHandling(m.text), '[⌚ 0:12 · continuous] Dentist at noon');
  assert.equal(stripHandling(`x\n\n${VOICE_MODE_INSTRUCTION}`), 'x');
});

test('history: tag and note removed, last message of each run is the answer', () => {
  const sent = messageFor('Dentist at noon', { sec: 12, auto: true }, 'detailed').text;
  const { items, working } = t3HistoryItems([
    user(1, sent),
    agent(2, 'Let me check.', 'r1'),
    agent(5, 'Logged.', 'r1'),
    user(6, 'typed in the web app'),
    agent(7, 'Sure.', 'r6'),
  ], { activeRunId: null, pendingRequestCount: 0, updatedAt: at });
  assert.deepEqual(items.map((i) => [i.role, i.text, i.watch]), [
    ['me', 'Dentist at noon', true],
    ['agent', 'Logged.', undefined],
    ['me', 'typed in the web app', false],
    ['agent', 'Sure.', undefined],
  ]);
  assert.equal(items[0].at, Date.parse(at));
  assert.equal(working, null);
});

test('history: a running turn shows as working, not as an answer', () => {
  const { items, working } = t3HistoryItems([user(1, 'hi'), agent(2, 'Looking now', 'run1')],
    { activeRunId: 'run1', pendingRequestCount: 0, updatedAt: at });
  assert.deepEqual(items.map((i) => i.role), ['me']);
  assert.equal(working.line, 'Looking now');
});

test('history: a question to the user shows in working; other threads and bare slash commands are left out', () => {
  const { items, working } = t3HistoryItems([user(1, 'from a child', { senderThreadId: 't2' }), user(2, '/compact')],
    { activeRunId: 'run1', pendingRequestCount: 1, updatedAt: at });
  assert.deepEqual(items, []);
  assert.equal(working.line, 'Waiting for your answer in T3');
});

const fakeReader = (waits, answer = 'done', pending = 0) => {
  const asked = [];
  return {
    asked,
    call: async (tool, args) => {
      if (tool === 't3_thread_read') return { thread: { pendingRequestCount: pending } };
      asked.push(args.runId);
      const next = waits.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    runAnswer: async (_thread, runId) => { asked.push(`answer:${runId}`); return answer; },
  };
};

test('reply: follows only this run, past time slices and T3 restarts', async () => {
  const t3 = fakeReader([{ timedOut: true }, new T3Error('down'), { timedOut: false, runId: 'mine', status: 'completed' }]);
  const r = await waitForT3Reply(t3, 'thread', 'mine', { retryMs: 1 });
  assert.deepEqual(r, { text: 'done', status: 'completed' });
  assert.ok(t3.asked.every((id) => id === 'mine' || id === 'answer:mine'));
});

test('reply: a restart continues under the new run id', async () => {
  const t3 = fakeReader([{ timedOut: false, runId: 'continued', status: 'completed' }]);
  await waitForT3Reply(t3, 'thread', 'mine');
  assert.ok(t3.asked.includes('answer:continued'));
});

test('reply: a turn with no text gives none', async () => {
  const t3 = fakeReader([{ timedOut: false, runId: 'mine', status: 'completed' }], null);
  assert.equal(await waitForT3Reply(t3, 'thread', 'mine'), null);
});

test('reply: a run stopped on a question says so', async () => {
  const t3 = fakeReader([{ timedOut: true }, { timedOut: true }], 'x', 1);
  const r = await waitForT3Reply(t3, 'thread', 'mine');
  assert.equal(r.status, 'waiting');
  assert.match(r.text, /waiting for your answer/);
});

// A stand-in for the t3 binary.
function fakeBin(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 't3-bin-'));
  const bin = path.join(dir, 't3');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return { bin, dir };
}

test('send: text goes over stdin, never in the arguments', async () => {
  const { bin, dir } = fakeBin(`cat > "${'$'}(dirname "$0")/in"; echo "$*" > "${'$'}(dirname "$0")/args"; echo '{"runId":"r1","messageId":"m1","delivery":"queued"}'`);
  const sent = await new T3({ home: dir, bin }).send('thread-1', 'secret words');
  assert.equal(sent.runId, 'r1');
  assert.equal(fs.readFileSync(path.join(dir, 'in'), 'utf8'), 'secret words');
  const args = fs.readFileSync(path.join(dir, 'args'), 'utf8');
  assert.match(args, /thread send .*--json thread-1 -/);
  assert.doesNotMatch(args, /secret/);
});

test('send: T3 down gives a plain failure with its reason', async () => {
  const { bin, dir } = fakeBin('echo "Could not reach the T3 Code server" >&2; exit 1');
  await assert.rejects(new T3({ home: dir, bin }).send('thread-1', 'x'), (e) => e instanceof T3Error && !e.unsure && /Could not reach/.test(e.message));
});

test('send: an unreadable answer that did land is not sent twice', async () => {
  const { bin, dir } = fakeBin('echo not-json');
  const t3 = new T3({ home: dir, bin });
  t3.findRecentNote = async () => ({ runId: 'r9', messageId: 'm9' });
  assert.equal((await t3.send('thread-1', 'x')).delivery, 'recovered');
  t3.findRecentNote = async () => null;
  await assert.rejects(t3.send('thread-1', 'x'), (e) => e.unsure);
});

test('sends keep their order, and a failure does not block the next', async () => {
  const { bin, dir } = fakeBin(`read line; echo "$line" >> "${'$'}(dirname "$0")/order"; [ "$line" = two ] && exit 1; [ "$line" = one ] && sleep 0.2; echo '{"runId":"r"}'`);
  const t3 = new T3({ home: dir, bin });
  const all = await Promise.allSettled(['one\n', 'two\n', 'three\n'].map((m) => t3.send('thread-1', m)));
  assert.deepEqual(all.map((a) => a.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(fs.readFileSync(path.join(dir, 'order'), 'utf8'), 'one\ntwo\nthree\n');
});

test('binary: follows the version the T3 service has active', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 't3-home-'));
  assert.throws(() => t3Binary(home), T3Error);
  fs.mkdirSync(path.join(home, 'runtime/versions/9.9'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runtime/service-state.json'), '{"activeVersion":"9.9"}');
  assert.throws(() => t3Binary(home), /not found/);
  fs.writeFileSync(path.join(home, 'runtime/versions/9.9/t3'), '');
  assert.equal(t3Binary(home), path.join(home, 'runtime/versions/9.9/t3'));
});

test('room audio: the header wins, then the first try, and an unknown retry counts as room audio', () => {
  const cases = [
    [{ header: '1', hasDuration: true }, true],                     // Continuous, first try
    [{ header: '1', hasDuration: false }, true],                    // 1.0.41+ retry
    [{ header: '0', hasDuration: false, remembered: '1' }, false],  // 1.0.41+ retry of a single note
    [{ hasDuration: true }, false],                                 // single note, first try
    [{ hasDuration: false, remembered: '1' }, true],                // old retry, first try reached us
    [{ hasDuration: false, remembered: '0' }, false],
    [{ hasDuration: false }, true],                                 // old retry, first try never arrived
  ];
  for (const [input, want] of cases) assert.equal(isRoomAudio(input), want, JSON.stringify(input));
});

test('target: t3:<id> is that thread; old t3 is the thread old builds knew; never a guess', () => {
  assert.equal(parseT3Target('t3:mcp:abcd-1234', 'old-0001'), 'mcp:abcd-1234');
  assert.equal(parseT3Target('t3:abcd-1234', null), 'abcd-1234');
  assert.equal(parseT3Target('t3', 'old-0001'), 'old-0001');
  assert.equal(parseT3Target('t3', null), null);
  assert.equal(parseT3Target('main', 'old-0001'), null);
  assert.equal(parseT3Target('t3:', 'old-0001'), null);
  assert.equal(parseT3Target('t3:bad id/../x', 'old-0001'), null);
  assert.equal(isT3Wire('t3'), true);
  assert.equal(isT3Wire('t3:x'), true);
  assert.equal(isT3Wire('t3x'), false);
  assert.equal(isT3Wire(undefined), false);
});

test('T3 screen: only threads not settled or snoozed, newest first, nothing pinned', () => {
  const t = (threadId, updatedAt, extra = {}) => ({ threadId, title: threadId, projectId: 'p', status: 'completed', updatedAt, settled: false, snoozed: false, ...extra });
  const rows = t3ThreadRows([
    t('old', '2026-11-01T00:00:00Z'),
    t('new', '2026-11-02T00:00:00Z', { status: 'running' }),
    t('settled', '2026-11-03T00:00:00Z', { settled: true }),
    t('snoozed', '2026-11-03T00:00:00Z', { snoozed: true }),
    t('archived', '2026-11-03T00:00:00Z', { archived: true }),
    t('child', '2026-11-03T00:00:00Z', { relationshipToParent: 'subagent' }),
    t('fork', '2026-10-01T00:00:00Z', { relationshipToParent: 'fork' }),
  ], { projects: new Map([['p', 'Proj']]) });
  assert.deepEqual(rows.map((r) => r.id), ['t3:new', 't3:old', 't3:fork']);
  assert.equal(rows[0].running, true);
  assert.equal(rows[0].project, 'Proj');
  assert.equal(rows[0].flag, null);
});

test('T3 screen: the chosen thread stays visible and flagged, only once', () => {
  const t = (threadId, extra = {}) => ({ threadId, title: threadId, projectId: 'p', status: 'completed', updatedAt: '2026-11-01T00:00:00Z', settled: false, snoozed: false, ...extra });
  const off = t3ThreadRows([t('a')], { selected: t('mine', { settled: true }) });
  assert.deepEqual(off.map((r) => [r.id, r.flag]), [['t3:mine', 'settled'], ['t3:a', null]]);
  assert.equal(t3ThreadRows([t('a')], { selected: t('a') }).length, 1);
  assert.equal(t3Flag(t('x', { snoozed: true })), 'snoozed');
});
