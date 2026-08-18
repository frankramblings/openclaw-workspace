import { test } from 'node:test';
import assert from 'node:assert';

// chat.js pulls in browser globals at import time (api.js reads location.origin,
// stream-manager touches localStorage) — shim the minimum before importing.
globalThis.location = globalThis.location || { origin: 'http://localhost' };
globalThis.localStorage = globalThis.localStorage || { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis.window || globalThis;
globalThis.document = globalThis.document || { querySelector: () => null };
globalThis.requestAnimationFrame = globalThis.requestAnimationFrame || (() => 1);
globalThis.cancelAnimationFrame = globalThis.cancelAnimationFrame || (() => {});

const { commitSeparator } = await import('../redesign/live/chat.js');

test('narration gets exactly one trailing blank line so the answer is its own paragraph', () => {
  assert.equal(commitSeparator("I'll research this."), "I'll research this.\n\n");
});

test('trailing whitespace is collapsed into the single blank-line separator (no soup)', () => {
  assert.equal(commitSeparator('Found the stack.   '), 'Found the stack.\n\n');
  assert.equal(commitSeparator('Found the stack.\n'), 'Found the stack.\n\n');
});

test('already-separated text is left alone (no double blank lines on repeat commits)', () => {
  assert.equal(commitSeparator('Working on it.\n\n'), 'Working on it.\n\n');
});

test('empty / whitespace-only text is returned unchanged (nothing to keep)', () => {
  assert.equal(commitSeparator(''), '');
  assert.equal(commitSeparator('   '), '   ');
  assert.equal(commitSeparator(undefined), '');
  assert.equal(commitSeparator(null), '');
});
