// Tests for the 700ms composer send-buffer (Task 7): a submit appends an
// optimistic bubble + arms a timer instead of firing the network request
// immediately, so an edit made during the window is what actually gets sent.
//
// live/chat.js is a browser module (fetch/location/DOM), so this test stubs
// the minimum browser surface it touches, then drives it through node:test's
// fake timers exactly like the real 700ms deadline.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time) ------------
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');

function freshState() {
  return {
    draft: '',
    pendingAttach: [],
    live: { chat: { activeId: 'sess-1', model: 'test-model', thread: [] } },
  };
}

test('composer send buffers 700ms — mid-window edit wins the actual POST', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const fetchCalls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, body: null };
  });
  runtime.render = () => {};

  try {
    const state = freshState();
    runtime.state = state;
    state.draft = 'original text';

    await actions.send();

    // Nothing hit the network yet — the send is buffered.
    assert.strictEqual(fetchCalls.length, 0);
    const chat = state.live.chat;
    assert.ok(chat.pendingSend, 'pendingSend should be armed after submit');
    const messageId = chat.pendingSend.messageId;
    assert.strictEqual(chat.pendingSend.text, 'original text');

    // The optimistic bubble is in the thread with the edit predicate's markers.
    const bubble = chat.thread.find((m) => m.id === messageId);
    assert.ok(bubble, 'optimistic bubble should be appended immediately');
    assert.strictEqual(bubble._optimistic, true);
    assert.strictEqual(bubble.text, 'original text');

    // Simulate Task 8's mid-edit: the pending text is mutated in place.
    chat.pendingSend.text = 'edited text';

    // Advance past the 700ms deadline — this should flush the EDITED text.
    mock.timers.tick(700);

    assert.strictEqual(fetchCalls.length, 1, 'exactly one POST should fire at flush');
    const body = fetchCalls[0].opts.body;
    assert.ok(body instanceof FormData, 'chat_stream POST sends a FormData body');
    assert.strictEqual(body.get('message'), 'edited text', 'the flushed POST must carry the edited text, not the original');

    // Post-flush: pendingSend is cleared and the bubble lost its optimistic flags.
    assert.strictEqual(chat.pendingSend, null);
    assert.strictEqual(bubble._optimistic, undefined);
    assert.strictEqual(bubble.text, 'edited text');
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

test('a second submit while one is buffered flushes the first synchronously', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const fetchCalls = [];
  globalThis.fetch = mock.fn(async (url, opts) => {
    fetchCalls.push({ url, opts });
    return { ok: true, body: null };
  });
  runtime.render = () => {};

  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    state.draft = 'first message';
    await actions.send();
    const firstId = chat.pendingSend.messageId;
    assert.strictEqual(fetchCalls.length, 0);

    // Second send arrives inside the first's 700ms window.
    state.draft = 'second message';
    await actions.send();

    // The first message must have been flushed (its own POST fired) before the
    // second one claimed pendingSend.
    assert.strictEqual(fetchCalls.length, 1, 'the buffered first message flushes synchronously');
    assert.strictEqual(fetchCalls[0].opts.body.get('message'), 'first message');

    const firstBubble = chat.thread.find((m) => m.id === firstId);
    assert.strictEqual(firstBubble._optimistic, undefined, 'first bubble is no longer optimistic once flushed');

    assert.ok(chat.pendingSend, 'the second message now owns pendingSend');
    assert.strictEqual(chat.pendingSend.text, 'second message');

    // Let the second one's timer expire too, so nothing leaks into other tests.
    mock.timers.tick(700);
    assert.strictEqual(fetchCalls.length, 2);
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
  }
});
