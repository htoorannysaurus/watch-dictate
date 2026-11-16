import test from 'node:test';
import assert from 'node:assert/strict';
import { capExtras, cappedExtras, chatName, chatState, mainEntry, readListing, refusalFor, selectedEntry, stateIn, watchList, ARCHIVED, GONE, NO_NAME } from '../lib/chats.mjs';

process.env.HAPPY_CLIENT_MODULE ??= new URL('./stub-happy-client.mjs', import.meta.url).href;
const { Happy } = await import('../lib/happy.mjs');

const chat = (name, extra = {}) => ({ metadata: { manualTitle: { text: name }, ...extra }, active: false });
const listing = new Map([
  ['live', chat('Live', { lifecycleState: 'running' })],
  ['stopped', chat('Stopped', { lifecycleState: 'stopped' })],
  ['asleep', chat('Asleep', { lifecycleState: 'running' })],
  ['arch', chat('Archived', { lifecycleState: 'archived' })],
  ['arching', chat('Archiving', { lifecycleState: 'archiveRequested' })],
  ['locked', { metadata: null }],
]);
const relay = ({ gone = [], settings = {} } = {}) => {
  const asked = [];
  return { asked, isGone: async (id) => { asked.push(id); return gone.includes(id); }, settings: async () => { if (settings instanceof Error) throw settings; return settings; } };
};

test('only an archive or a real delete changes a chat; being offline does not', async () => {
  const happy = relay({ gone: ['dead'] });
  assert.equal(await chatState(happy, 'live', listing), 'ok');
  assert.equal(await chatState(happy, 'stopped', listing), 'ok');
  assert.equal(await chatState(happy, 'asleep', listing), 'ok');
  assert.equal(await chatState(happy, 'arch', listing), 'archived');
  assert.equal(await chatState(happy, 'arching', listing), 'archived');
  assert.equal(await chatState(happy, 'dead', listing), 'deleted');
});

test('a chat is not deleted until the list and its own lookup agree', async () => {
  assert.equal(await chatState(relay(), 'absent', listing), 'unknown');           // on no list, but its lookup didn't say gone
  const happy = relay({ gone: ['dead'] });
  assert.equal(await chatState(happy, 'dead', null), 'unknown');                  // list not read
  assert.deepEqual(happy.asked, []);
  assert.equal(await chatState(happy, 'locked', listing), 'unknown');             // listed but undecryptable
  assert.deepEqual(happy.asked, []);
});

test('the watch list hides archived chats, drops deleted ones, keeps the order', async () => {
  const names = new Map();
  const list = await watchList(relay({ gone: ['dead'] }), ['asleep', 'arch', 'dead', 'live'], listing, names);
  assert.deepEqual(list.destinations, [{ id: 'asleep', title: 'Asleep' }, { id: 'live', title: 'Live' }]);
  assert.deepEqual(list.archived, ['arch']);
  assert.deepEqual(list.deleted, ['dead']);
});

test('when the list can not be read, nothing leaves and names survive', async () => {
  const names = new Map([['live', 'Live']]);
  const list = await watchList(relay({ gone: ['live', 'never'] }), ['live', 'never', 'arch'], null, names);
  assert.deepEqual(list.destinations, [{ id: 'live', title: 'Live' }, { id: 'never', title: NO_NAME }, { id: 'arch', title: NO_NAME }]);
  assert.deepEqual(list.deleted, []);
  assert.deepEqual(list.archived, []);
});

test('an archived chat stays hidden through a failed read, and returns once resumed', async () => {
  const hidden = new Set(), names = new Map();
  await watchList(relay(), ['arch'], listing, names, hidden);
  assert.deepEqual((await watchList(relay(), ['arch'], null, names, hidden)).destinations, []);
  const resumed = new Map([['arch', chat('Archived', { lifecycleState: 'running' })]]);
  assert.deepEqual((await watchList(relay(), ['arch'], resumed, names, hidden)).destinations, [{ id: 'arch', title: 'Archived' }]);
});

test('a name change shows up, and the last name is kept for a chat that can not be read', () => {
  const names = new Map([['locked', 'Old'], ['live', 'Old']]);
  assert.equal(chatName('live', listing, names), 'Live');
  assert.equal(chatName('locked', listing, names), 'Old');
});

test('Main: set, none, cleared by a delete, archived, and unknown', async () => {
  const names = new Map();
  assert.deepEqual(await mainEntry(relay({ settings: { mainChatSessionId: 'live' } }), listing, names), { id: 'live', title: 'Live', state: 'ok' });
  assert.deepEqual(await mainEntry(relay({ settings: { mainChatSessionId: null } }), listing, names), { state: 'none' });
  assert.deepEqual(await mainEntry(relay({ settings: { mainChatSessionId: '' } }), listing, names), { state: 'none' });
  assert.deepEqual(await mainEntry(relay({ gone: ['dead'], settings: { mainChatSessionId: 'dead' } }), listing, names), { state: 'none' });
  assert.deepEqual(await mainEntry(relay({ settings: { mainChatSessionId: 'arch' } }), listing, names), { id: 'arch', title: 'Archived', state: 'archived' });
  assert.equal(await mainEntry(relay({ settings: new Error('relay down') }), listing, names), undefined);
  assert.equal(await mainEntry(relay({ settings: { mainChatSessionId: 'live' } }), null, names), undefined);
});

test('the selected chat reports its state, and nothing when it can not be told', async () => {
  const names = new Map();
  assert.deepEqual(await selectedEntry(relay(), 'live', listing, names), { id: 'live', title: 'Live', state: 'ok' });
  assert.deepEqual(await selectedEntry(relay(), 'arch', listing, names), { id: 'arch', title: 'Archived', state: 'archived' });
  assert.deepEqual(await selectedEntry(relay({ gone: ['dead'] }), 'dead', listing, names), { id: 'dead', state: 'deleted' });
  assert.equal(await selectedEntry(relay({ gone: ['dead'] }), 'dead', null, names), undefined);
});

test('notes: archived and deleted are refused, anything uncertain goes ahead', async () => {
  const happy = relay({ gone: ['dead'] });
  assert.equal(await refusalFor(happy, 'arch', listing), ARCHIVED);
  assert.equal(await refusalFor(happy, 'dead', listing), GONE);
  assert.equal(await refusalFor(happy, 'asleep', listing), null);
  assert.equal(await refusalFor(happy, 'dead', null), null);
});

test('Main and hidden chats do not use up the 8 places', () => {
  const ids = ['main', 'hid', ...Array.from({ length: 10 }, (_, i) => `c${i}`)];
  const kept = capExtras(ids, (id) => id === 'main' || id === 'hid');
  assert.deepEqual(kept, ['main', 'hid', 'c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
});

test('an iPhone edit while the relay is down cuts nothing', () => {
  const ids = ['mainchat', 'arch', ...Array.from({ length: 9 }, (_, i) => `c${i}`)];
  assert.deepEqual(cappedExtras(ids, null, undefined), ids);
  assert.deepEqual(cappedExtras(ids, listing, undefined), ids);
  const main = { id: 'mainchat', state: 'ok' };
  assert.deepEqual(cappedExtras(ids, listing, main), ids.slice(0, 10));   // Main and arch are free, c0-c7 fit
});

test('a failed read gives no list at all', async () => {
  assert.equal(await readListing({ readChats: async () => { throw new Error('HTTP 500'); } }), null);
  assert.equal(stateIn(null, 'live'), 'unknown');
});

function fakeHappy(pages) {
  const happy = new Happy({ server: 'http://x', pushServer: 'http://x' });
  let n = 0;
  happy.request = async () => { const p = pages[n++]; if (p instanceof Error) throw p; return p; };
  happy.calls = () => n;
  return happy;
}

test('the list walk only succeeds when every page came back', async () => {
  await assert.rejects(fakeHappy([{ sessions: [], hasNext: true, nextCursor: 'a' }, new Error('Happy GET: HTTP 500')]).readChats(), /500/);
});

test('a row it can not decrypt is still listed, so it never looks deleted', async () => {
  const chats = await fakeHappy([{ sessions: [{ id: 'x', metadata: 'junk', metadataVersion: 1, active: false }], hasNext: false }]).readChats();
  assert.equal(chats.has('x'), true);
  assert.equal(chats.get('x').metadata, null);
  assert.equal(stateIn(chats, 'x'), 'unknown');
});

test('a chat dropped from a complete list leaves the cache; a failed read keeps it', async () => {
  const happy = fakeHappy([new Error('HTTP 500'), { sessions: [], hasNext: false }]);
  happy.sessions.set('old', { id: 'old', metadata: {} });
  await assert.rejects(happy.walkChats());
  assert.equal(happy.sessions.has('old'), true);
  await happy.walkChats();
  assert.equal(happy.sessions.has('old'), false);
});

test('reads close together share one walk; a failed walk is not shared', async () => {
  const happy = fakeHappy([new Error('HTTP 500'), { sessions: [], hasNext: false }, { sessions: [], hasNext: false }]);
  await assert.rejects(happy.readChats());
  await happy.readChats();
  await happy.readChats();
  assert.equal(happy.calls(), 2);
});

test('only a real 404 means a chat is gone', async () => {
  const on = (err) => { const h = fakeHappy([]); h.request = async () => { if (err) throw err; return {}; }; return h; };
  assert.equal(await on(new Error('Happy GET /v3: HTTP 404')).isGone('x'), true);
  assert.equal(await on(new Error('Happy GET /v3: HTTP 500')).isGone('x'), false);
  assert.equal(await on(new Error('fetch failed')).isGone('x'), false);
  assert.equal(await on(null).isGone('x'), false);
});
