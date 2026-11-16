import test from 'node:test';
import assert from 'node:assert/strict';
import { applyDictionary } from '../lib/replace.mjs';


test('replaces whole words and phrases, case-insensitively', () => {
  const dict = [{ word: 'Alexa', replacement: 'Alex' }, { word: 'one password', replacement: '1Password' }];
  assert.equal(applyDictionary('I told alexa about One  Password.', dict), 'I told Alex about 1Password.');
});

test('never rewrites part of a word', () => {
  assert.equal(applyDictionary('Monologue and monologues', [{ word: 'Monolog', replacement: 'Monologue' }]), 'Monologue and monologues');
});

test('does not cascade replacements', () => {
  const dict = [{ word: 'Cal', replacement: 'Sam' }, { word: 'Sam', replacement: 'WRONG' }];
  assert.equal(applyDictionary('Call Cal', dict), 'Call Sam');
});

test('skips vocabulary-only entries', () => {
  assert.equal(applyDictionary('use git here', [{ word: 'git' }]), 'use git here');
});

test('fixes the misheard Claudeputer from the first watch notes', () => {
  assert.equal(applyDictionary('Claude Peuter dictation.', [{ word: 'Claude Peuter', replacement: 'Claudeputer' }]), 'Claudeputer dictation.');
});
