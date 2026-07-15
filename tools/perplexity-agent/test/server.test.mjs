import { test } from 'node:test';
import assert from 'node:assert/strict';
import { askSchema, normalizeAskInput } from '../src/server.mjs';

test('exports MCP ask schema', () => {
  assert.equal(askSchema.type, 'object');
  assert.equal(askSchema.properties.prompt.type, 'string');
  assert.equal(askSchema.required[0], 'prompt');
});

test('normalizes ask input defaults', () => {
  assert.deepEqual(normalizeAskInput({ prompt: 'hi' }), {
    prompt: 'hi',
    model: 'perplexity-auto',
    maxRounds: 4,
  });
});
