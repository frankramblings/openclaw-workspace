import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time; same pattern
// as chat-turn-epoch.test.js / api-contract.test.js) --------------------------
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { buildQuestionCardModel } = await import('../redesign/live/chat.js');

test('buildQuestionCardModel maps an AskUserQuestion tool_start', () => {
  const ev = { type: 'tool_start', tool: 'AskUserQuestion', tool_id: 't1',
    input: { questions: [{ question: 'Pause?', header: 'IPTV', multiSelect: false,
      options: [{ label: 'Yes', description: '' }] }] } };
  const m = buildQuestionCardModel(ev);
  assert.equal(m.toolId, 't1');
  assert.equal(m.model.questions[0].header, 'IPTV');
});

test('buildQuestionCardModel returns null for non-question tools', () => {
  assert.equal(buildQuestionCardModel({ tool: 'Bash', input: {} }), null);
});
