import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/runtime.mjs';

function fakeClient(outputs) {
  let i = 0;
  return {
    async complete(messages) {
      return { text: outputs[i++] || 'FINAL: fallback', messagesSeen: messages.length };
    },
  };
}

test('returns final answer without tools', async () => {
  const result = await runAgent({
    prompt: 'hi',
    modelClient: fakeClient(['FINAL: hello']),
    tools: {},
  });
  assert.equal(result.answer, 'hello');
  assert.equal(result.rounds, 1);
  assert.deepEqual(result.trace, []);
});

test('runs an allowlisted tool and continues', async () => {
  const result = await runAgent({
    prompt: 'look this up',
    modelClient: fakeClient([
      'THOUGHT: need search\nTOOL web_search {"query":"OpenClaw"}',
      'FINAL: found it',
    ]),
    tools: {
      web_search: async (input) => ({ results: [{ title: input.query, url: 'https://example.com' }] }),
    },
  });
  assert.equal(result.answer, 'found it');
  assert.equal(result.rounds, 2);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].tool, 'web_search');
});

test('stops on unknown tools', async () => {
  const result = await runAgent({
    prompt: 'do bad thing',
    modelClient: fakeClient(['TOOL shell {"cmd":"rm -rf /"}']),
    tools: {},
  });
  assert.equal(result.stopped_reason, 'unknown_tool');
  assert.match(result.answer, /Unknown tool/);
});

test('stops at max rounds', async () => {
  const result = await runAgent({
    prompt: 'loop',
    modelClient: fakeClient([
      'TOOL web_search {"query":"1"}',
      'TOOL web_search {"query":"2"}',
    ]),
    tools: { web_search: async () => 'ok' },
    maxRounds: 2,
  });
  assert.equal(result.stopped_reason, 'max_rounds');
  assert.equal(result.trace.length, 2);
});
