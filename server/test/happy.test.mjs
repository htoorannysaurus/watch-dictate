import test from 'node:test';
import assert from 'node:assert/strict';

process.env.HAPPY_CLIENT_MODULE ??= new URL('./stub-happy-client.mjs', import.meta.url).href;
const { noteMeta } = await import('../lib/happy.mjs');

test('the steer flag is on the message only when asked for', () => {
  const claude = { metadata: { flavor: 'claude' } };
  assert.deepEqual(noteMeta(claude, { text: 'a' }), { sentFrom: 'watch', permissionMode: 'bypassPermissions' });
  assert.deepEqual(noteMeta(claude, { text: 'a', steer: true }), { sentFrom: 'watch', permissionMode: 'bypassPermissions', steer: true });
});

test('the rest of the meta is unchanged', () => {
  assert.equal(noteMeta({ metadata: { flavor: 'codex' } }, { text: 'a', steer: true }).permissionMode, 'yolo');
  assert.equal(noteMeta({ metadata: {} }, { text: 'long', displayText: 'short' }).displayText, 'short');
  assert.equal('displayText' in noteMeta({ metadata: {} }, { text: 'same', displayText: 'same' }), false);
});
