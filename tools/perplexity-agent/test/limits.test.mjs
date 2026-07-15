import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compactToolResult } from '../src/limits.mjs';

test('leaves small string results untouched', () => {
  assert.equal(compactToolResult('short', 20), 'short');
});

test('trims long string results with a truncation note', () => {
  const out = compactToolResult('abcdefghijklmnopqrstuvwxyz', 10);
  assert.equal(out, 'abcdefghij\n[truncated 16 chars]');
});

test('serializes and trims object results deterministically', () => {
  const out = compactToolResult({ b: 2, a: 1 }, 100);
  assert.equal(out, '{\n  "b": 2,\n  "a": 1\n}');
});
