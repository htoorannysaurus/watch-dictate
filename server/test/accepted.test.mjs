import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcceptedNotes, readHeldNotes, retryDelayMs, writeAtomic } from '../lib/accepted.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wd-accepted-'));

test('an accepted note is kept with its audio until done', () => {
  const dir = tmp();
  const notes = new AcceptedNotes(dir);
  notes.save('clip-0001', Buffer.from('audio'), { target: 'abc12345', engine: 'deepgram' });
  assert.equal(notes.has('clip-0001'), true);
  const [record] = notes.due();
  assert.equal(record.clipId, 'clip-0001');
  assert.equal(record.meta.target, 'abc12345');
  assert.equal(notes.audio('clip-0001').toString(), 'audio');
  notes.done('clip-0001');
  assert.equal(notes.has('clip-0001'), false);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a new store finds what an earlier one saved (restart)', () => {
  const dir = tmp();
  new AcceptedNotes(dir).save('clip-0002', Buffer.from('a'), { target: 't3:thread-1' });
  assert.deepEqual(new AcceptedNotes(dir).due().map((r) => r.clipId), ['clip-0002']);
});

test('a failed try waits longer each time, then the note is set aside with its audio', () => {
  const dir = tmp();
  const notes = new AcceptedNotes(dir, { maxTries: 3 });
  notes.save('clip-0003', Buffer.from('a'), {});
  assert.equal(notes.failed('clip-0003', 1000), true);
  assert.deepEqual(notes.due(1000 + retryDelayMs(1) - 1), []);
  assert.equal(notes.due(1000 + retryDelayMs(1)).length, 1);
  assert.equal(notes.failed('clip-0003', 1000), true);
  assert.equal(notes.failed('clip-0003', 1000), false);
  assert.deepEqual(notes.due(Infinity), []);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['clip-0003.json.gave-up', 'clip-0003.m4a']);
});

test('retry waits double up to an hour', () => {
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(30), 3_600_000);
});

test('a bad record is set aside and the others still come back', () => {
  const dir = tmp();
  const notes = new AcceptedNotes(dir);
  notes.save('clip-0004', Buffer.from('a'), {});
  fs.writeFileSync(path.join(dir, 'aaaa.json'), '{ not json');
  fs.writeFileSync(path.join(dir, 'bbbb.json'), JSON.stringify({ clipId: 'bbbb' }));   // no audio
  assert.deepEqual(notes.due().map((r) => r.clipId), ['clip-0004']);
  assert.equal(fs.existsSync(path.join(dir, 'aaaa.json.bad')), true);
  assert.equal(fs.existsSync(path.join(dir, 'bbbb.json.bad')), true);
});

test('one unreadable held note does not block the rest', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'a.json'), '{"clipId":"a-clip","te');   // cut off mid-write
  fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ clipId: 'b-clip', text: 'hello', target: 'abc12345' }));
  const held = readHeldNotes(dir);
  assert.deepEqual(held.map((h) => h.note.clipId), ['b-clip']);
  assert.equal(fs.existsSync(path.join(dir, 'a.json.bad')), true);
  assert.deepEqual(readHeldNotes(dir).map((h) => h.note.clipId), ['b-clip']);
});

test('writeAtomic leaves no temp file', () => {
  const dir = tmp();
  writeAtomic(path.join(dir, 'x.json'), '{}');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
});
