// Chat history for the watch: the last few messages of a chat, the user's notes and the agent's
// answers, newest last. Built from the relay's decrypted /v3 messages (seq order).
//
// An agent turn mixes answers with narration ("Let me check…") between tool calls. The watch
// shows only an answer: agent text that no tool call follows before the next boundary (a user
// message or the turn's end). A user message that joins a running turn splits it, so the
// answer to an earlier note in the same turn stays in the history.

export const TAG = /^\s*\[⌚[^\]]*\]\s*|^\s*⌚\s*/;   // the watch note tag (server/lib/message.mjs)
const LIVE_LIMIT_MS = 15 * 60_000;           // a turn with no news for this long isn't "working"
const MAX_TEXT = 2000;

/** What one decrypted message means for the history, or null. */
export function historyEvent(content) {
  if (!content) return null;
  if (content.role === 'user' && content.content?.type === 'text') {
    const meta = content.meta ?? {};
    const raw = String(meta.displayText ?? content.content.text ?? '');
    return { kind: 'user', text: raw.replace(TAG, '').trim(), watch: meta.sentFrom === 'watch' || TAG.test(raw) };
  }
  if (content.role !== 'session') return null;
  const env = content.content;
  if (!env?.ev || env.subagent) return null;   // sub-agent work never reaches the chat's answers
  if (env.role === 'user' && env.ev.t === 'text') return { kind: 'user', text: env.ev.text.trim(), watch: false };
  if (env.role !== 'agent') return null;
  switch (env.ev.t) {
    case 'text': return env.ev.thinking ? null : { kind: 'text', text: env.ev.text };
    case 'tool-call-start': return { kind: 'tool' };
    case 'turn-start': return { kind: 'start' };
    case 'turn-end': return { kind: 'end' };
    default: return null;
  }
}

/** messages: [{ seq, createdAt, content }] oldest first. Returns the last `limit` items and,
 *  while a turn is running, `working` with the latest narration line (or null). */
export function historyItems(messages, { limit = 20, now = Date.now() } = {}) {
  const items = [];
  let pending = [];        // answer candidates since the last tool call or boundary
  let open = false;        // a turn is running
  let lastLiveAt = 0, lastLine = null;

  const flush = () => {
    const text = pending.map((p) => p.text.trim()).filter(Boolean).join('\n\n');
    if (text) {
      const last = pending.at(-1);
      items.push({ id: `a${last.seq}`, seq: last.seq, role: 'agent', text: clip(text), at: last.at });
    }
    pending = [];
  };

  for (const m of messages) {
    const e = historyEvent(m.content);
    if (!e) continue;
    const at = m.createdAt ?? null;
    if (e.kind === 'user') {
      flush();
      // A bare slash command (/compact) is housekeeping, not conversation.
      if (e.text && !/^\/\S+$/.test(e.text)) items.push({ id: `u${m.seq}`, seq: m.seq, role: 'me', text: clip(e.text), at, watch: e.watch });
      lastLine = null;
      continue;
    }
    if (e.kind === 'start') { open = true; lastLiveAt = at ?? now; continue; }
    if (e.kind === 'end') { flush(); open = false; lastLine = null; continue; }
    open = true; lastLiveAt = at ?? now;
    if (e.kind === 'tool') { pending = []; continue; }   // what came before it was narration
    pending.push({ text: e.text, seq: m.seq, at });
    lastLine = e.text;
  }

  // A turn still running: its unfinished text shows as "working", not as an answer yet.
  const working = open && now - lastLiveAt < LIVE_LIMIT_MS
    ? { line: lastLine ? oneLine(lastLine) : null, at: lastLiveAt }
    : null;
  if (!working) flush();
  return { items: items.slice(-limit), working };
}

export const clip = (text) => (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT).trimEnd() + '…' : text);
export const oneLine = (text) => {
  const s = text.replace(/```[\s\S]*?```/g, ' ').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > 140 ? s.slice(0, 140).trimEnd() + '…' : s;
};

/** Per-chat cache of decrypted messages: one backward fill, then forward pages only, so the
 *  watch can poll every few seconds without re-reading the chat. */
export class HistoryCache {
  constructor(happy, { keep = 3000, fill = 1500 } = {}) {
    this.happy = happy; this.keep = keep; this.fill = fill;
    this.chats = new Map();   // sessionId -> { messages, maxSeq }
    this.busy = new Map();    // sessionId -> refresh in flight (two long-polls must not both append)
  }

  messages(session) {
    const running = this.busy.get(session.id);
    if (running) return running;
    const p = this.refresh(session).finally(() => this.busy.delete(session.id));
    this.busy.set(session.id, p);
    return p;
  }

  async refresh(session) {
    let c = this.chats.get(session.id);
    if (!c) {
      const messages = await this.happy.latestMessages(session, this.fill);
      c = { messages, maxSeq: messages.at(-1)?.seq ?? 0 };
      this.chats.set(session.id, c);
      return c.messages;
    }
    for (let page = 0; page < 10; page++) {
      const next = await this.happy.messagesAfter(session, c.maxSeq);
      if (!next.length) break;
      c.messages.push(...next);
      c.maxSeq = next.at(-1).seq;
      if (next.length < 500) break;
    }
    if (c.messages.length > this.keep) c.messages.splice(0, c.messages.length - this.keep);
    return c.messages;
  }
}
