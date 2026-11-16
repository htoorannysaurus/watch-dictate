import test from 'node:test';
import assert from 'node:assert/strict';
import { replyTracker, turnOpen } from '../lib/replies.mjs';

const ev = (turn, e) => ({ role: 'session', content: { role: 'agent', turn, ev: e } });
const picked = (ids) => ({ role: 'agent', content: { type: 'event', data: { type: 'message-picked-up', happyMessageIds: ids } } });

test('returns the final text of the turn that picks up the note', () => {
  const t = replyTracker('m1');
  assert.equal(t(picked(['m1'])), null);
  assert.equal(t(ev('a', { t: 'turn-start' })), null);
  assert.equal(t(ev('a', { t: 'text', text: 'Let me check.' })), null);
  assert.deepEqual(t(ev('a', { t: 'turn-end', status: 'completed' })), { text: 'Let me check.', status: 'completed' });
});

test('ignores the end of an earlier turn that never picked the note up', () => {
  const t = replyTracker('m2');
  assert.equal(t(ev('old', { t: 'text', text: 'Earlier answer' })), null);
  assert.equal(t(ev('old', { t: 'turn-end', status: 'completed' })), null);
  t(picked(['m2'])); t(ev('new', { t: 'turn-start' }));
  t(ev('new', { t: 'text', text: 'Checking' }));
  t(ev('new', { t: 'text', text: 'Done: logged it.' }));
  assert.deepEqual(t(ev('new', { t: 'turn-end', status: 'completed' })), { text: 'Done: logged it.', status: 'completed' });
});

test('a note picked up mid-turn is answered by that turn', () => {
  const t = replyTracker('m3');
  t(picked(['m3']));
  t(ev('cur', { t: 'text', text: 'Also noted your second message.' }));
  assert.deepEqual(t(ev('cur', { t: 'turn-end', status: 'completed' })), { text: 'Also noted your second message.', status: 'completed' });
});

test('a steered note gets the answer of the turn it joined, not the text before it', () => {
  const session = (ev, turn = 't1') => ({ role: 'session', content: { role: 'agent', turn, ev } });
  const track = replyTracker('note');
  // The turn is already running when the note is posted: no turn-start after it.
  assert.equal(track(session({ t: 'text', text: 'still on the old work' })), null);
  assert.equal(track({ role: 'agent', content: { type: 'event', data: { type: 'message-picked-up', happyMessageIds: ['note'] } } }), null);
  assert.equal(track(session({ t: 'text', text: 'Got your note. Changed course.' })), null);
  assert.deepEqual(track(session({ t: 'turn-end', status: 'completed' })), { text: 'Got your note. Changed course.', status: 'completed' });
});

test('turnOpen: the last turn boundary decides, and sub-agent turns do not count', () => {
  const ev = (t, extra = {}) => ({ role: 'session', content: { role: 'agent', turn: 't', ev: { t }, ...extra } });
  assert.equal(turnOpen([ev('turn-start'), ev('tool-call-start')]), true);
  assert.equal(turnOpen([ev('turn-start'), ev('turn-end', {})]), false);
  assert.equal(turnOpen([ev('turn-start'), ev('turn-end'), { role: 'user', content: { type: 'text', text: 'hi' } }]), false);
  assert.equal(turnOpen([ev('turn-start'), ev('turn-end', { subagent: 'x' })]), true);
  assert.equal(turnOpen([{ role: 'user', content: { type: 'text', text: 'hi' } }]), null);
});
