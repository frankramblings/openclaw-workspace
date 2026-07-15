import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCliArgs } from '../src/cli.mjs';

test('parses prompt and defaults', () => {
  assert.deepEqual(parseCliArgs(['research this']), {
    prompt: 'research this',
    model: 'perplexity-auto',
    maxRounds: 4,
    json: false,
  });
});

test('parses model, rounds, and json flag', () => {
  assert.deepEqual(parseCliArgs(['--model', 'claude-sonnet-4-6', '--max-rounds', '2', '--json', 'hi']), {
    prompt: 'hi',
    model: 'claude-sonnet-4-6',
    maxRounds: 2,
    json: true,
  });
});
