// What state a Claudeputer chat is in, as the watch needs to know it, and the lists built from that.
//
// Only two things take a chat off the watch: the chat says it was archived, or the relay no longer
// has it. Whether a chat is connected never counts: a sleeping machine isn't a closed chat.
// Any read that fails means "don't know", and "don't know" changes nothing.

export const NO_NAME = '(name unavailable)';
export const GONE = 'That chat is gone. Pick another chat';
export const ARCHIVED = 'That chat is archived. Pick another chat';

export const chatTitle = (m) => m?.pinnedTitle?.text || m?.manualTitle?.text || m?.summary?.text || (m?.path || '').split('/').filter(Boolean).pop() || 'Untitled';
export const isArchived = (m) => m?.lifecycleState === 'archived' || m?.lifecycleState === 'archiveRequested';

/** The relay's whole chat list, or null when it couldn't be read in full. */
export async function readListing(happy, log = () => {}) {
  try { return await happy.readChats(); } catch (err) { log(`chat list not read: ${err.message}`); return null; }
}

/** 'ok', 'archived', 'missing' (not on a complete list) or 'unknown'. */
export function stateIn(listing, id) {
  if (!listing) return 'unknown';
  const chat = listing.get(id);
  if (!chat) return 'missing';
  if (!chat.metadata) return 'unknown';   // the relay has it; it just can't be read here
  return isArchived(chat.metadata) ? 'archived' : 'ok';
}

/** 'ok', 'archived', 'deleted' or 'unknown'. Deleted takes the list and the chat's own lookup agreeing. */
export async function chatState(happy, id, listing) {
  const state = stateIn(listing, id);
  if (state !== 'missing') return state;
  return await happy.isGone(id) ? 'deleted' : 'unknown';
}

/** The chat's current name, or the last one seen if it can't be read now. */
export function chatName(id, listing, names) {
  const metadata = listing?.get(id)?.metadata;
  if (metadata) names.set(id, chatTitle(metadata));
  return names.get(id) ?? NO_NAME;
}

/** The hand-picked chats split up: the ones to show, the archived ones to hide, the deleted ones to drop.
 *  `hidden` remembers which are archived, so a failed read leaves them hidden too. */
export async function watchList(happy, ids, listing, names, hidden = new Set()) {
  const destinations = [], archived = [], deleted = [];
  for (const id of ids) {
    const state = await chatState(happy, id, listing);
    if (state === 'archived') hidden.add(id);
    else if (state !== 'unknown') hidden.delete(id);
    if (state === 'deleted') deleted.push(id);
    else if (hidden.has(id)) { archived.push(id); chatName(id, listing, names); }
    else destinations.push({ id, title: chatName(id, listing, names) });
  }
  return { destinations, archived, deleted };
}

/** Claudeputer's Main for the watch's Main row. Undefined when it can't be told: the watch keeps what it knew. */
export async function mainEntry(happy, listing, names) {
  let id;
  try { id = (await happy.settings()).mainChatSessionId || null; } catch { return undefined; }
  if (!id) return { state: 'none' };
  const state = await chatState(happy, id, listing);
  if (state === 'unknown') return undefined;
  if (state === 'deleted') return { state: 'none' };
  return { id, title: chatName(id, listing, names), state };
}

/** The state of the chat the watch has selected. Undefined when it can't be told. */
export async function selectedEntry(happy, id, listing, names) {
  const state = await chatState(happy, id, listing);
  if (state === 'unknown') return undefined;
  return state === 'deleted' ? { id, state } : { id, title: chatName(id, listing, names), state };
}

/** Why this chat can't take a note, or null. If that can't be told, the send goes ahead and finds out. */
export async function refusalFor(happy, id, listing) {
  const state = await chatState(happy, id, listing);
  return state === 'archived' ? ARCHIVED : state === 'deleted' ? GONE : null;
}

/** The list the iPhone asked for, capped. If the relay can't say which chats count, nothing is cut. */
export function cappedExtras(asked, listing, main) {
  if (!listing || main === undefined) return asked;
  return capExtras(asked, (id) => id === main.id || stateIn(listing, id) === 'archived');
}

/** Keeps the first `max` chats that count. Main and hidden chats don't use up a place. */
export function capExtras(ids, uncounted, max = 8) {
  let counted = 0;
  return ids.filter((id) => uncounted(id) || ++counted <= max);
}
