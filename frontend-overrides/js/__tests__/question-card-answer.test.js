import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time; same pattern
// as question-card-wiring.test.js) -------------------------------------------
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { __setDispatchForTest, answerQuestionCard } = await import('../redesign/live/chat.js');

test('answerQuestionCard forwards the composed answer to dispatchSend', () => {
  const sent = [];
  __setDispatchForTest((text) => sent.push(text));
  answerQuestionCard('t1', 'Yes, pause it');
  assert.deepEqual(sent, ['Yes, pause it']);
});
