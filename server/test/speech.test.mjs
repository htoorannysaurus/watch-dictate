import test from 'node:test';
import assert from 'node:assert/strict';
import { speakable } from '../lib/speech.mjs';

test('speakable drops markup, code, tables and URLs', () => {
  const md = "Done. I **logged** it in [today's log](https://x.y/z).\n\n```js\nx()\n```\n| a | b |\n|---|---|\n- See `notes.md` at https://example.com";
  assert.equal(speakable(md), "Done. I logged it in today's log. See notes.md at");
});
