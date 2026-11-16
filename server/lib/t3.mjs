// T3 Code as a note destination. Two logins, neither stored on disk:
//  - Sending: `t3 thread send`. The CLI signs itself in through T3's local auth files (it runs as
//    the machine's owner), holds a session for about 2 s, and revokes it when it exits.
//  - Reading (reply following, chat page): a read-only MCP session we issue ourselves, kept in
//    memory only, replaced every 50 minutes. T3 refuses every write from it.
// T3 won't take a send from a login with fewer rights than the target thread, and the Orchestrator
// runs full-access, so a stored scoped token can't send to it. See README "T3 destination".

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { clip, oneLine, TAG } from './history.mjs';
import { stripHandling } from './message.mjs';

/** Is a clip aimed at T3 Continuous room audio, so it needs the handling note? The header wins, then
 *  what the first try told us. Watch 1.0.40 and older send neither on an outbox retry (no X-Auto, no
 *  X-Duration-Ms), so that case counts as room audio: an extra note costs little, a missing one doesn't. */
export function isRoomAudio({ header, hasDuration, remembered }) {
  if (header === '1' || header === '0') return header === '1';
  if (remembered === '1' || remembered === '0') return remembered === '1';
  return !hasDuration;
}

export const isT3Wire = (wanted) => wanted === 't3' || (typeof wanted === 'string' && wanted.startsWith('t3:'));

/** The thread a T3 target means, or null. 't3:<id>' is that thread. Plain 't3' only comes from watch
 *  builds before 1.0.42 and their queued clips, and means the thread they knew (`legacyId`). */
export function parseT3Target(wanted, legacyId) {
  if (wanted === 't3') return legacyId || null;
  if (typeof wanted !== 'string' || !wanted.startsWith('t3:')) return null;
  const id = wanted.slice(3);
  return /^[A-Za-z0-9:_-]{8,80}$/.test(id) ? id : null;
}

const flagOf = (t) => (t.archived ? 'archived' : t.settled ? 'settled' : t.snoozed ? 'snoozed' : null);
const t3Row = (t, projects) => ({ id: `t3:${t.threadId}`, title: t.title, project: projects.get(t.projectId) ?? null, running: t.status === 'running', flag: flagOf(t) });

/** The T3 screen: every thread that isn't settled, snoozed, archived or a sub-agent, newest first.
 *  `selected`: the thread notes go to now, kept visible and flagged even if it no longer qualifies. */
export function t3ThreadRows(threads, { selected = null, projects = new Map() } = {}) {
  const rows = threads
    .filter((t) => !flagOf(t) && t.relationshipToParent !== 'subagent')
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .map((t) => t3Row(t, projects));
  if (selected && !rows.some((r) => r.id === `t3:${selected.threadId}`)) rows.unshift(t3Row(selected, projects));
  return rows;
}

/** The T3 thread's state for the pill: 'settled', 'snoozed', 'archived' or null. */
export const t3Flag = flagOf;

const SEND_TIMEOUT_MS = 30_000;
const READ_TTL_MIN = 60;
const READ_ROTATE_MS = 50 * 60_000;
const PAGE = 100;

/** A T3 failure. `unsure`: the command died before answering, so the send may have landed. */
export class T3Error extends Error {
  constructor(message, { unsure = false } = {}) { super(message); this.name = 'T3Error'; this.unsure = unsure; }
}

/** The runtime T3's service runs now. Read each time, so T3 updates are picked up. */
export function t3Binary(home, override) {
  if (override) return override;
  let version;
  try { version = JSON.parse(fs.readFileSync(path.join(home, 'runtime/service-state.json'), 'utf8')).activeVersion; }
  catch (err) { throw new T3Error(`T3 runtime state unreadable: ${err.code ?? err.message}`); }
  const bin = path.join(home, 'runtime/versions', String(version), 't3');
  if (!fs.existsSync(bin)) throw new T3Error(`T3 runtime ${version} not found`);
  return bin;
}

export class T3 {
  constructor({ home = process.env.WATCH_DICTATE_T3_HOME || path.join(os.homedir(), '.t3'), bin = process.env.WATCH_DICTATE_T3_BIN, log = () => {} } = {}) {
    this.home = home; this.binOverride = bin; this.log = log;
    this.sendTail = Promise.resolve();   // one send at a time, so notes land in order
    this.login = null; this.loggingIn = null;
    this.mcp = null; this.nextId = 0;
    this.cache = new Map();              // `${threadId}:${count}` -> { at, p }
  }

  cli(args, { input, timeoutMs = SEND_TIMEOUT_MS } = {}) {
    return new Promise((resolve, reject) => {
      let bin;
      try { bin = t3Binary(this.home, this.binOverride); } catch (err) { reject(err); return; }
      const child = execFile(bin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        const line = String(stderr).trim().split('\n').at(-1)?.slice(0, 300) || err.message.split('\n')[0];
        // Killed by our timeout or a signal: T3 may have taken the message before it died.
        reject(new T3Error(line, { unsure: !!(err.killed || err.signal) }));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(input ?? '');
    });
  }

  /** Queues the text as the thread's next turn (nothing running is interrupted). The text goes
   *  over stdin, so it never shows in `ps`. Returns { runId, messageId, delivery, ... }. */
  send(threadId, text) {
    const run = () => this.sendOnce(threadId, text);
    const p = this.sendTail.then(run, run);
    this.sendTail = p.catch(() => {});
    return p;
  }

  async sendOnce(threadId, text) {
    try {
      const out = await this.cli(['thread', 'send', '--base-dir', this.home, '--json', threadId, '-'], { input: text });
      let sent;
      try { sent = JSON.parse(out); } catch { throw new T3Error('T3 sent an unreadable answer', { unsure: true }); }
      if (!sent?.runId) throw new T3Error('T3 answered without a run id', { unsure: true });
      return sent;
    } catch (err) {
      if (!err.unsure) throw err;
      // Don't send a note twice: look for it before reporting a failure, so the watch's retry
      // can't double it. Read errors leave this a plain failure, which is retried.
      const landed = await this.findRecentNote(threadId, text).catch(() => null);
      if (landed?.runId) return { runId: landed.runId, messageId: landed.messageId, delivery: 'recovered' };
      throw err;
    }
  }

  /** A user message with exactly this text in the last few minutes of the thread. */
  async findRecentNote(threadId, text, { withinMs = 5 * 60_000 } = {}) {
    const { items } = await this.latestMessages(threadId, 12, { fresh: true, maxChars: 50_000 });
    return items.findLast((i) => i.type === 'user_message' && i.text === text
      && Date.now() - Date.parse(i.updatedAt) < withinMs) ?? null;
  }

  // --- the read-only login ---

  async readLogin() {
    if (this.login && Date.now() - this.login.at < READ_ROTATE_MS) return this.login;
    this.loggingIn ??= this.issueLogin().finally(() => { this.loggingIn = null; });
    return this.loggingIn;
  }

  async issueLogin() {
    const old = this.login;
    const out = await this.cli(['auth', 'session', 'issue', '--base-dir', this.home, '--subject', 'mcp-client',
      '--scope', 'orchestration:read', '--ttl', `${READ_TTL_MIN}m`, '--label', 'watch-dictate read-only', '--json']);
    let issued;
    try { issued = JSON.parse(out); } catch { throw new T3Error('T3 sent an unreadable login'); }
    if (!issued?.token) throw new T3Error('T3 sent no login');
    this.login = { token: issued.token, sessionId: issued.sessionId, at: Date.now() };
    this.mcp = null;
    if (old) this.revoke(old.sessionId);
    return this.login;
  }

  revoke(sessionId) {
    return this.cli(['auth', 'session', 'revoke', '--base-dir', this.home, sessionId]).catch((err) => this.log(`t3: revoke failed: ${err.message}`));
  }

  /** Ends the read-only session (on shutdown). It would expire within the hour anyway. */
  async close() {
    const old = this.login;
    this.login = null; this.mcp = null;
    if (old) await this.revoke(old.sessionId);
  }

  origin() {
    try { return JSON.parse(fs.readFileSync(path.join(this.home, 'userdata/server-runtime.json'), 'utf8')).origin; }
    catch { return 'http://127.0.0.1:3773'; }
  }

  async post(message, timeoutMs = 15_000) {
    const { token } = await this.readLogin();
    const headers = {
      'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`,
      ...(this.mcp?.session ? { 'mcp-session-id': this.mcp.session } : {}),
      ...(this.mcp?.protocol ? { 'mcp-protocol-version': this.mcp.protocol } : {}),
    };
    let res;
    try {
      res = await fetch(new URL('/mcp', this.origin()), { method: 'POST', headers, body: JSON.stringify(message), signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) { throw new T3Error(`T3 unreachable: ${err.message}`); }
    const body = await res.text();
    if (!res.ok) throw Object.assign(new T3Error(`T3 read: HTTP ${res.status}`), { http: res.status });
    if (!body) return { headers: res.headers, payload: null };
    const payloads = (res.headers.get('content-type') || '').includes('event-stream')
      ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => { try { return JSON.parse(l.slice(5)); } catch { return null; } })
      : [JSON.parse(body)];
    return { headers: res.headers, payload: payloads.find((p) => p?.id === message.id) ?? null };
  }

  async connect() {
    if (this.mcp) return;
    this.mcp = {};
    try {
      const { headers, payload } = await this.post({ jsonrpc: '2.0', id: ++this.nextId, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'watch-dictate', version: '1' } } });
      if (!payload?.result) throw new T3Error('T3 MCP did not start');
      this.mcp = { session: headers.get('mcp-session-id'), protocol: payload.result.protocolVersion };
      await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    } catch (err) { this.mcp = null; throw err; }
  }

  /** One read tool. After a T3 restart or an expired login the session is gone: start over once. */
  async call(tool, args, { timeoutMs = 15_000 } = {}) {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.connect();
        const { payload } = await this.post({ jsonrpc: '2.0', id: ++this.nextId, method: 'tools/call', params: { name: tool, arguments: args } }, timeoutMs);
        if (!payload) throw new T3Error(`T3 ${tool}: no answer`);
        if (payload.error) throw new T3Error(`T3 ${tool}: ${payload.error.message}`);
        if (payload.result?.isError) throw new T3Error(`T3 ${tool}: ${String(payload.result.content?.[0]?.text ?? 'failed').slice(0, 300)}`);
        return payload.result.structuredContent;
      } catch (err) {
        if (attempt === 0 && (err.http === 401 || err.http === 404 || err.http === 400)) {
          if (err.http === 401) this.login = null;
          this.mcp = null;
          continue;
        }
        throw err;
      }
    }
  }

  /** Threads for the T3 screen, read-only, plus each project's name. */
  async listThreads() {
    const threads = [];
    let cursor = 0;
    for (let page = 0; page < 5 && cursor != null; page++) {
      const r = await this.call('t3_thread_list', { allProjects: true, settled: false, snoozed: false, includeSubagents: false, limit: 100, cursor });
      threads.push(...r.threads);
      cursor = r.nextCursor;
    }
    const { projects } = await this.call('t3_project_list', { limit: 100, cursor: 0 });
    return { threads, projects: new Map(projects.map((p) => [p.id, p.title])) };
  }

  /** The newest `count` user and assistant messages, oldest first, plus the thread. Timeline
   *  positions count tool calls too, so the read widens backward until it has enough. */
  async latestMessages(threadId, count, { fresh = false, maxChars = 2500, stop } = {}) {
    const key = `${threadId}:${count}:${maxChars}`;
    const hit = this.cache.get(key);
    if (!fresh && !stop && hit && Date.now() - hit.at < 2000) return hit.p;
    const p = this.readLatest(threadId, count, maxChars, stop);
    if (!stop) { this.cache.set(key, { at: Date.now(), p }); p.catch(() => this.cache.delete(key)); }
    return p;
  }

  async readLatest(threadId, count, maxChars, stop) {
    const head = await this.call('t3_thread_read', { threadId, limit: 1, runLimit: 1 });
    let thread = head.thread, items = [], end = Infinity, start = thread.itemCount, span = Math.max(count * 4, PAGE);
    for (let round = 0; round < 8 && start > 0 && items.length < count; round++) {
      start = Math.max(0, start - span);
      const window = [];
      let after = start - 1, page;
      do {
        page = await this.call('t3_thread_read', { threadId, view: 'messages', limit: PAGE, runLimit: 1, maxCharsPerItem: maxChars, ...(after < 0 ? {} : { afterPosition: after }) });
        window.push(...page.items.filter((i) => (i.type === 'user_message' || i.type === 'assistant_message') && i.position < end));
        after = page.nextPosition ?? Infinity;
      } while (page.hasMore && after < end - 1);
      thread = page.thread;
      items = window.concat(items);
      end = start;
      span *= 2;
      if (stop?.(items)) break;
    }
    return { thread, items: stop ? items : items.slice(-count) };
  }

  /** The last assistant message of one run, or null. */
  async runAnswer(threadId, runId) {
    const mine = (i) => i.type === 'assistant_message' && i.runId === runId;
    const { items } = await this.latestMessages(threadId, 400, { maxChars: 20_000, stop: (xs) => xs.some(mine) });
    return items.findLast(mine)?.text?.trim() || null;
  }
}

const SLICE_MS = 15_000;

/** Follows exactly this note's run until it ends. T3 names the run on send, so another turn in
 *  the thread can't stand in for the answer. A run stopped on a question reports that once. */
export async function waitForT3Reply(t3, threadId, runId, { timeoutMs = 60 * 60_000, sliceMs = SLICE_MS, retryMs = 5000 } = {}) {
  const until = Date.now() + timeoutMs;
  const wait = (ms) => t3.call('t3_thread_wait', { threadId, runId, timeoutMs: ms }, { timeoutMs: ms + 15_000 });
  const finish = async (w) => {
    const text = await t3.runAnswer(threadId, w.runId ?? runId);
    return text ? { text, status: w.status } : null;   // tools only, or stopped before answering
  };
  while (Date.now() < until) {
    try {
      const w = await wait(sliceMs);
      if (!w.timedOut) return await finish(w);
      const { thread } = await t3.call('t3_thread_read', { threadId, limit: 1, runLimit: 1 });
      if (thread.pendingRequestCount > 0) {
        // The count is thread-wide; if this run just ended, the question belongs to a later one.
        const again = await wait(1);
        if (!again.timedOut) return await finish(again);
        return { text: 'T3 is waiting for your answer. Open the thread to respond.', status: 'waiting' };
      }
    } catch {
      await new Promise((r) => setTimeout(r, retryMs));   // T3 restarting: keep following
    }
  }
  return null;
}

/** The watch chat page for a T3 thread, in the shape of historyItems (lib/history.mjs). Per run,
 *  only the last assistant message is the answer; earlier ones are narration between tools. */
export function t3HistoryItems(messages, thread, { limit = 20 } = {}) {
  const items = [];
  let pending = null;
  const at = (i) => { const ms = Date.parse(i.updatedAt); return Number.isNaN(ms) ? null : ms; };
  const flush = () => {
    if (pending) {
      const text = pending.text?.trim();
      if (text) items.push({ id: `a${pending.position}`, seq: pending.position, role: 'agent', text: clip(text), at: at(pending) });
    }
    pending = null;
  };
  for (const m of messages) {
    if (m.type === 'assistant_message') {
      if (pending && pending.runId !== m.runId) flush();
      pending = m;
      continue;
    }
    if (m.type !== 'user_message' || m.senderThreadId) continue;   // another thread's message isn't the user's
    flush();
    const raw = stripHandling(String(m.text ?? ''));
    const text = raw.replace(TAG, '').trim();
    if (text && !/^\/\S+$/.test(text)) items.push({ id: `u${m.position}`, seq: m.position, role: 'me', text: clip(text), at: at(m), watch: TAG.test(raw) });
  }
  let working = null;
  if (thread?.activeRunId) {
    const line = pending?.runId === thread.activeRunId ? oneLine(pending.text ?? '') : null;
    if (pending?.runId === thread.activeRunId) pending = null;   // unfinished: "working", not an answer yet
    working = { line: thread.pendingRequestCount > 0 ? 'Waiting for your answer in T3' : line || null, at: at(thread) };
  }
  flush();
  return { items: items.slice(-limit), working };
}
