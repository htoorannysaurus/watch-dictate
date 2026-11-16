// Happy relay access: account settings (dictation dictionary), session
// keys, sending a user message, and a socket listener that times the push to clients.
// Crypto and credential loading come from a separate Happy client module (HAPPY_CLIENT_MODULE) so
// there is one implementation of Happy's formats. Keys live only in this process.

const CLIENT_MODULE = process.env.HAPPY_CLIENT_MODULE;
if (!CLIENT_MODULE) throw new Error('Set HAPPY_CLIENT_MODULE to the path of a Happy client module');
const { dependencies, readCredentials, encrypt, decrypt, recordKey } = await import(CLIENT_MODULE);

/** The note's message meta. `steer` asks the agent to take it into the turn it is running. */
export function noteMeta(session, { displayText, text, steer = false } = {}) {
  const permissionMode = session.metadata?.flavor === 'codex' ? 'yolo' : 'bypassPermissions';
  return {
    sentFrom: 'watch', permissionMode,
    ...(displayText && displayText !== text ? { displayText } : {}),
    ...(steer ? { steer: true } : {}),
  };
}

const LISTING_SHARED_MS = 2000;

export class Happy {
  constructor({ server, pushServer }) {
    this.server = server;          // where we POST (localhost: skips Cloudflare)
    this.pushServer = pushServer;  // where the push listener connects (public, like the phone)
    this.credentials = readCredentials();
    const deps = dependencies();
    this.nacl = deps.nacl;
    this.io = deps.io;
    this.sessions = new Map();     // id -> { id, encryption, metadata }
    this.pending = new Map();      // localId -> resolve(pushedAtMs)
    this.changeWaiters = new Map(); // sessionId -> Set(wake)
  }

  async request(route, { method = 'GET', body } = {}) {
    const res = await fetch(this.server + route, {
      method,
      headers: { Authorization: `Bearer ${this.credentials.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Happy ${method} ${route.split('?')[0]}: HTTP ${res.status}`);
    return res.json();
  }

  /** Fresh on every call. */
  async settings() {
    const d = await this.request('/v1/account/settings');
    return d.settings ? decrypt(d.settings, { key: this.credentials.secret, variant: 'legacy' }, this.nacl) : {};
  }

  /** Every chat the relay lists, read fresh and shared for a moment. Fails unless the whole list came back. */
  readChats() {
    if (this.listing && Date.now() - this.listing.at < LISTING_SHARED_MS) return this.listing.chats;
    const entry = { at: Date.now(), chats: this.walkChats() };
    this.listing = entry;
    entry.chats.catch(() => { if (this.listing === entry) this.listing = null; });
    return entry.chats;
  }

  async walkChats() {
    const chats = new Map(); let cursor;
    for (let page = 0; page < 100; page++) {
      const d = await this.request('/v2/sessions?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      for (const raw of d.sessions) chats.set(raw.id, this.openRecord(raw));
      if (!d.hasNext) {
        for (const id of this.sessions.keys()) if (!chats.has(id)) this.sessions.delete(id);
        return chats;
      }
      cursor = d.nextCursor;
    }
    throw new Error('Happy chat list too long to read in full');
  }

  /** The record for a row of the list, re-read when the chat's details changed. No details: it can't be decrypted here. */
  openRecord(raw) {
    const live = { active: raw.active, activeAt: raw.activeAt, updatedAt: raw.updatedAt };
    try {
      let rec = this.sessions.get(raw.id);
      if (!rec || rec.metadataVersion !== raw.metadataVersion) {
        const encryption = rec?.encryption ?? recordKey(raw, this.credentials, this.nacl);
        const metadata = decrypt(raw.metadata, encryption, this.nacl);
        if (!metadata) throw new Error('no metadata');
        rec = { id: raw.id, encryption, metadata, metadataVersion: raw.metadataVersion };
        this.sessions.set(raw.id, rec);
      }
      return { ...rec, ...live };
    } catch { return { id: raw.id, metadata: null, ...live }; }
  }

  /** True only when the relay answers that this chat doesn't exist. */
  async isGone(id) {
    try { await this.request(`/v3/sessions/${encodeURIComponent(id)}/messages?limit=1`); return false; }
    catch (err) { return /HTTP 404/.test(err.message); }
  }

  /** Every chat that can be read here, for the chat picker. */
  async allSessions() {
    return [...(await this.readChats()).values()].filter((chat) => chat.metadata);
  }

  async session(id) {
    if (this.sessions.has(id)) return this.sessions.get(id);
    let cursor;
    for (let page = 0; page < 100; page++) {
      const d = await this.request('/v2/sessions?limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
      const raw = d.sessions.find((s) => s.id === id);
      if (raw) {
        const encryption = recordKey(raw, this.credentials, this.nacl);
        const record = { id, encryption, metadata: decrypt(raw.metadata, encryption, this.nacl), metadataVersion: raw.metadataVersion };
        this.sessions.set(id, record);
        return record;
      }
      if (!d.hasNext) break;
      cursor = d.nextCursor;
    }
    throw new Error(`Happy session ${id} not found`);
  }

  /** Stores a user message; the relay dedupes on localId, so retries are safe. The agent
   *  reads `text`; the Happy app shows `displayText` instead when given. A held note's retry
   *  leaves `steer` off: it's old by now. */
  async send(session, text, localId, { displayText, steer = false } = {}) {
    const meta = noteMeta(session, { displayText, text, steer });
    const content = encrypt(
      { role: 'user', content: { type: 'text', text }, meta },
      session.encryption, this.nacl,
    );
    const r = await this.request(`/v3/sessions/${encodeURIComponent(session.id)}/messages`, {
      method: 'POST', body: { messages: [{ localId, content }] },
    });
    return r.messages;
  }

  /** Messages after `seq`, decrypted, oldest first (up to 500). */
  async messagesAfter(session, seq) {
    const d = await this.request(`/v3/sessions/${encodeURIComponent(session.id)}/messages?after_seq=${seq}&limit=500`);
    return d.messages.map((m) => this.open(session, m));
  }

  /** The newest `count` messages, decrypted, oldest first (pages backward, 500 at a time). */
  async latestMessages(session, count) {
    const out = [];
    let before = 2147483647;   // the relay's seq column is a 32-bit int
    while (out.length < count) {
      const limit = Math.min(500, count - out.length);
      const d = await this.request(`/v3/sessions/${encodeURIComponent(session.id)}/messages?before_seq=${before}&limit=${limit}`);
      out.push(...d.messages.map((m) => this.open(session, m)));   // newest first
      if (!d.hasMore || !d.messages.length) break;
      before = d.messages.at(-1).seq;
    }
    return out.reverse();
  }

  open(session, m) {
    return {
      seq: m.seq,
      createdAt: m.createdAt,
      content: m.content?.t === 'encrypted' ? (() => { try { return decrypt(m.content.c, session.encryption, this.nacl); } catch { return null; } })() : m.content,
    };
  }

  /** Resolves on the next new message in the chat (from the push listener), or after `ms`. */
  waitForChange(sessionId, ms) {
    return new Promise((resolve) => {
      const set = this.changeWaiters.get(sessionId) ?? new Set();
      this.changeWaiters.set(sessionId, set);
      const wake = () => { clearTimeout(timer); set.delete(wake); if (!set.size) this.changeWaiters.delete(sessionId); resolve(); };
      const timer = setTimeout(wake, ms);
      set.add(wake);
    });
  }

  /** Resolves with the time a user-scoped client (like the phone) received the message. */
  waitForPush(localId, timeoutMs = 5000) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(localId); resolve(null); }, timeoutMs);
      this.pending.set(localId, (at) => { clearTimeout(timer); this.pending.delete(localId); resolve(at); });
    });
  }

  listen(log) {
    const socket = this.io(this.pushServer, {
      path: '/v1/updates',
      auth: { token: this.credentials.token, clientType: 'user-scoped' },
      transports: ['websocket'],
    });
    socket.on('connect', () => log('push listener connected'));
    socket.on('disconnect', (reason) => log(`push listener disconnected: ${reason}`));
    socket.on('update', (u) => {
      const m = u?.body?.t === 'new-message' ? u.body.message : null;
      const done = m?.localId && this.pending.get(m.localId);
      if (done) done(Date.now());
      if (m) for (const wake of this.changeWaiters.get(u.body.sid) ?? []) wake();
    });
    this.socket = socket;
  }
}
