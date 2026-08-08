import { test } from 'node:test';
import assert from 'node:assert/strict';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time; same pattern
// as question-card-wiring.test.js / question-card-answer.test.js) -----------
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { __setQuestionAnswers, isQuestionLocked, lockedChoice } = await import('../redesign/live/chat.js');

test('lock helpers read the answers map', () => {
  __setQuestionAnswers({ t1: { answered: true, choice: 'Yes' } });
  assert.equal(isQuestionLocked('t1'), true);
  assert.equal(lockedChoice('t1'), 'Yes');
  assert.equal(isQuestionLocked('t2'), false);
  assert.equal(lockedChoice('t2'), '');
});
