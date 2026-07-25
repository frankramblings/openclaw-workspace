// setModel/setDefaultModel must act only on composite ids that resolve in the
// loaded catalog. The old fallback treated an unresolved id as a bare model
// name and KEPT the chat's previous endpointId — writing cross-paired session
// records like claude-cli/gpt-5.5, which the gateway bounces every turn with
// "model not allowed" (2026-07-24). Browser shims per chat-turn-epoch.test.js.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class {
  constructor(url) { this.url = String(url); this.readyState = 1; }
  close() { this.readyState = 2; }
};
globalThis.EventSource.CLOSED = 2;

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');

const LIST = [
  { id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Claude Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
  { id: 'openai·gpt-5.5', mid: 'gpt-5.5', name: 'GPT-5.5', endpointId: 'openai', ep: 'ChatGPT' },
];

function freshState() {
  return {
    surface: 'chat',
    live: {
      modelList: LIST,
      chat: { activeId: 'sess-1', model: 'claude-opus-4-8', endpointId: 'claude-cli', thread: [] },
    },
  };
}

function withPatchCapture(fn) {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return { ok: true, json: async () => ({}) };
  };
  const prior = runtime.state;
  try { return fn(calls); } finally { globalThis.fetch = origFetch; runtime.state = prior; }
}

test('setModel with a resolved id updates model AND endpoint together', () => {
  withPatchCapture((calls) => {
    const s = freshState();
    runtime.state = s;
    actions.setModel('openai·gpt-5.5');
    assert.equal(s.live.chat.model, 'gpt-5.5');
    assert.equal(s.live.chat.endpointId, 'openai');
  });
});

test('setModel with an unresolved id is a no-op (never cross-pairs)', () => {
  withPatchCapture((calls) => {
    const s = freshState();
    runtime.state = s;
    actions.setModel('gpt-5.5'); // bare model name, not in the catalog list
    assert.equal(s.live.chat.model, 'claude-opus-4-8');
    assert.equal(s.live.chat.endpointId, 'claude-cli');
    assert.equal(calls.length, 0, 'no PATCH may be sent for an unresolved id');
  });
});

test('setDefaultModel with an unresolved id is a no-op', async () => {
  await withPatchCapture(async (calls) => {
    const s = freshState();
    runtime.state = s;
    await actions.setDefaultModel('gpt-5.5');
    assert.notEqual(s.live.defaultModel, 'gpt-5.5');
    assert.equal(calls.length, 0, 'no POST may be sent for an unresolved id');
  });
});
