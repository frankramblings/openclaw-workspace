import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssistantOutput } from '../src/protocol.mjs';

test('parses a final answer', () => {
  assert.deepEqual(parseAssistantOutput('FINAL: done'), {
    type: 'final',
    answer: 'done',
  });
});

test('treats plain text as final answer', () => {
  assert.deepEqual(parseAssistantOutput('No tools needed.'), {
    type: 'final',
    answer: 'No tools needed.',
  });
});

test('parses a tool call with JSON input', () => {
  assert.deepEqual(parseAssistantOutput('THOUGHT: search first\nTOOL web_search {"query":"OpenClaw"}'), {
    type: 'tool',
    tool: 'web_search',
    input: { query: 'OpenClaw' },
    thought: 'search first',
  });
});

test('returns invalid_tool_json for malformed JSON', () => {
  const parsed = parseAssistantOutput('TOOL web_search {"query":');
  assert.equal(parsed.type, 'invalid_tool_json');
  assert.equal(parsed.tool, 'web_search');
  assert.match(parsed.error, /JSON/);
});

test('rejects tool names outside the simple identifier format', () => {
  assert.deepEqual(parseAssistantOutput('TOOL ../../shell {"cmd":"ls"}'), {
    type: 'final',
    answer: 'TOOL ../../shell {"cmd":"ls"}',
  });
});
