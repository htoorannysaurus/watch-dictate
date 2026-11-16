// Reply-back: after a watch note posts to a chat, wait for the agent's turn that answers it
// and return the turn's final text (what the chat shows as the answer). Messages come from
// the relay's /v3 history, polled on localhost.

/** The agent event inside one decrypted message (text, turn start/end, or the CLI picking
 *  up queued user messages), or null. */
export function agentEvent(content) {
  if (content?.role === 'agent' && content.content?.type === 'event' && content.content.data?.type === 'message-picked-up') {
    return { kind: 'picked', ids: content.content.data.happyMessageIds ?? [] };
  }
  if (content?.role !== 'session') return null;
  const env = content.content;
  if (env?.role !== 'agent' || !env.ev) return null;
  if (env.ev.t === 'text' && typeof env.ev.text === 'string') return { kind: 'text', turn: env.turn, text: env.ev.text };
  if (env.ev.t === 'turn-end') return { kind: 'end', turn: env.turn, status: env.ev.status };
  if (env.ev.t === 'turn-start') return { kind: 'start', turn: env.turn };
  return null;
}

/** Whether decrypted messages (oldest first) end inside a running turn. null: no turn boundary
 *  in them. Sub-agent events belong to the child, not the chat's turn. */
export function turnOpen(contents) {
  for (let i = contents.length - 1; i >= 0; i--) {
    if (contents[i]?.content?.subagent) continue;
    const e = agentEvent(contents[i]);
    if (e?.kind === 'end') return false;
    if (e?.kind === 'start') return true;
  }
  return null;
}

/** Feed decrypted messages (in seq order, all after the note); returns the reply once the
 *  turn that answers the note ends, else null. The answering turn is the one running when
 *  the CLI picks the note up (it can join a turn already under way), or failing a pickup
 *  event, any turn that started after the note. */
export function replyTracker(messageId) {
  const texts = new Map();   // turn -> [text]
  const started = new Set();
  let picked = false;
  return (content) => {
    const e = agentEvent(content);
    if (!e) return null;
    if (e.kind === 'picked') { if (e.ids.includes(messageId)) picked = true; return null; }
    if (e.kind === 'start') started.add(e.turn);
    const live = (turn) => picked || started.has(turn);
    if (e.kind === 'text' && live(e.turn)) texts.set(e.turn, [...(texts.get(e.turn) ?? []), e.text]);
    if (e.kind === 'end' && live(e.turn)) {
      const all = texts.get(e.turn) ?? [];
      const final = all.at(-1)?.trim();
      if (final) return { text: final, status: e.status };
      started.delete(e.turn);   // a turn with no text (tools only): keep waiting for the next
      picked = false;
    }
    return null;
  };
}

/** Polls the chat after `afterSeq` until the answering turn ends or the time runs out. */
export async function waitForReply(happy, session, { seq: afterSeq, id }, { timeoutMs = 20 * 60_000, pollMs = 2000 } = {}) {
  const track = replyTracker(id);
  let cursor = afterSeq;
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    let page;
    try { page = await happy.messagesAfter(session, cursor); } catch { page = []; }
    for (const m of page) {
      cursor = Math.max(cursor, m.seq);
      const reply = track(m.content);
      if (reply) return reply;
    }
    // Wake on the chat's next message (push listener); the poll is the fallback.
    if (page.length < 500) await (happy.waitForChange ? happy.waitForChange(session.id, pollMs) : new Promise((r) => setTimeout(r, pollMs)));
  }
  return null;
}
