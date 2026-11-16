// The answer rule is the part that can silently lose a reply: a second note that joins a
// running turn must not swallow the answer to the first, and narration before a tool call
// must not pass for an answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { historyItems } from '../lib/history.mjs';

let seq = 0;
const user = (text, meta = { sentFrom: 'watch' }) => ({ seq: ++seq, createdAt: 1000 + seq, content: { role: 'user', content: { type: 'text', text }, meta } });
const ev = (e) => ({ seq: ++seq, createdAt: 1000 + seq, content: { role: 'session', content: { role: 'agent', turn: 't', ev: e } } });
const text = (t, extra = {}) => ev({ t: 'text', text: t, ...extra });

test('a note joining a running turn keeps the answer to the earlier note', () => {
  const msgs = [user('[⌚ 0:04] first?'), ev({ t: 'turn-start' }), text('hidden', { thinking: true }), text('Answer one.'),
    user('[⌚ 0:06] second'), text('Let me log that.'), ev({ t: 'tool-call-start' }), ev({ t: 'tool-call-end' }),
    text('Logged it.'), ev({ t: 'turn-end', status: 'completed' })];
  const { items, working } = historyItems(msgs, { now: 2000 });
  assert.deepEqual(items.map((i) => [i.role, i.text]), [['me', 'first?'], ['agent', 'Answer one.'], ['me', 'second'], ['agent', 'Logged it.']]);
  assert.equal(items[0].watch, true);
  assert.equal(working, null);
});

test('a running turn is "working" with its latest line, not an answer yet', () => {
  const msgs = [user('/compact', {}), user('typed on the phone', {}), ev({ t: 'turn-start' }), text('Checking the logs now.'), ev({ t: 'tool-call-start' })];
  const { items, working } = historyItems(msgs, { now: 2000 });
  assert.deepEqual(items.map((i) => i.role), ['me']);
  assert.equal(items[0].watch, false);
  assert.equal(working.line, 'Checking the logs now.');
});
