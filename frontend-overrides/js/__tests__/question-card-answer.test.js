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
const { runtime } = await import('../redesign/live/runtime.js');

function stubPost(resolved, seen) {
  globalThis.fetch = async (url, opts) => {
    seen.url = url;
    seen.body = JSON.parse(opts.body);
    return { ok: true, json: async () => ({ ok: true, resolved }) };
  };
}

test('answering a live card resolves the Gateway question instead of sending a message', async () => {
  // An AskUserQuestion parks the turn on a pending Gateway question. Sending
  // the answer as a chat message leaves it pending, so the session stays
  // blocked_tool_call for the tool's whole timeout.
  const sent = [];
  const seen = {};
  __setDispatchForTest((text) => sent.push(text));
  runtime.state = { live: { chat: { activeId: 'sess1', thread: [] } } };
  stubPost(true, seen);

  const resolved = await answerQuestionCard('t1', 'Location: Dover', [['Dover']]);

  assert.equal(resolved, true);
  assert.deepEqual(sent, []);
  assert.equal(seen.url, '/api/question-answer');
  assert.deepEqual(seen.body.answers, [['Dover']]);
  assert.equal(seen.body.tool_id, 't1');
});

test('answering a card the Gateway no longer has pending falls back to sending', async () => {
  const sent = [];
  const seen = {};
  __setDispatchForTest((text) => sent.push(text));
  runtime.state = { live: { chat: { activeId: 'sess1', thread: [] } } };
  stubPost(false, seen);

  const resolved = await answerQuestionCard('t2', 'Yes, pause it', [['Yes, pause it']]);

  assert.equal(resolved, false);
  assert.deepEqual(sent, ['Yes, pause it']);
});

test('answerQuestionCard still sends when the answer POST fails outright', async () => {
  const sent = [];
  __setDispatchForTest((text) => sent.push(text));
  runtime.state = { live: { chat: { activeId: 'sess1', thread: [] } } };
  globalThis.fetch = async () => { throw new Error('offline'); };

  await answerQuestionCard('t3', 'Yes, pause it', [['Yes, pause it']]);

  assert.deepEqual(sent, ['Yes, pause it']);
});
