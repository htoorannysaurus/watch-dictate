import test from 'node:test';
import assert from 'node:assert/strict';
import { messageFor, CONTINUOUS_NOTE, shouldSteer } from '../lib/message.mjs';

test('normal notes are unchanged and have no display override', () => {
  assert.deepEqual(messageFor('Picked up milk.', { sec: 12, auto: false }, 'detailed'), { text: '[⌚ 0:12] Picked up milk.' });
});

test('continuous notes carry the handling note for the agent, the plain note for display', () => {
  const m = messageFor('Turn on the bed.', { sec: 42, auto: true }, 'detailed');
  assert.equal(m.displayText, '[⌚ 0:42 · continuous] Turn on the bed.');
  assert.equal(m.text, `[⌚ 0:42 · continuous] ${CONTINUOUS_NOTE}\n\nTurn on the bed.`);
});

test('continuous notes with the tag off still get the handling note', () => {
  const m = messageFor('Hi.', { sec: 5, auto: true }, 'off');
  assert.equal(m.text, `${CONTINUOUS_NOTE}\n\nHi.`);
  assert.equal(m.displayText, 'Hi.');
});

test('voice mode ends the sent note with the voice instruction, hidden from the bubble', async () => {
  const { messageFor, VOICE_MODE_INSTRUCTION, CONTINUOUS_NOTE } = await import('../lib/message.mjs');
  const plain = messageFor('hi there', { sec: 7 }, 'detailed', { voice: true });
  assert.equal(plain.text, `[⌚ 0:07] hi there\n\n${VOICE_MODE_INSTRUCTION}`);
  assert.equal(plain.displayText, '[⌚ 0:07] hi there');
  const auto = messageFor('hi', { sec: 3, auto: true }, 'detailed', { voice: true });
  assert.equal(auto.text, `[⌚ 0:03 · continuous] ${CONTINUOUS_NOTE}\n\nhi\n\n${VOICE_MODE_INSTRUCTION}`);
  assert.deepEqual(messageFor('hi', { sec: 3 }, 'detailed'), { text: '[⌚ 0:03] hi' });
});

const note = { midTurn: 'steer', auto: false, continuousOn: false, retry: false, flavor: 'claude', text: '[⌚ 0:05] hi' };

test('a note spoken on purpose steers when the setting says steer', () => {
  assert.equal(shouldSteer(note), true);
  assert.equal(shouldSteer({ ...note, flavor: 'codex' }), true);
  assert.equal(shouldSteer({ ...note, flavor: undefined }), true);   // sessions from before flavors are Claude
});

test('the queue setting never steers', () => {
  assert.equal(shouldSteer({ ...note, midTurn: 'queue' }), false);
  assert.equal(shouldSteer({ ...note, midTurn: 'queue', flavor: 'codex' }), false);
});

test('Continuous never steers: its own notes, and one started by hand while it is on', () => {
  assert.equal(shouldSteer({ ...note, auto: true }), false);
  assert.equal(shouldSteer({ ...note, continuousOn: true }), false);
});

test('a retried note never steers: it is old by now', () => {
  assert.equal(shouldSteer({ ...note, retry: true }), false);
});

test('agents with no steer and slash commands do not ask for one', () => {
  for (const flavor of ['gemini', 'grok', 'opencode', 'antigravity', 'openclaw']) assert.equal(shouldSteer({ ...note, flavor }), false);
  assert.equal(shouldSteer({ ...note, text: '/compact' }), false);
});
