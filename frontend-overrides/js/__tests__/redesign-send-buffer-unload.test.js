// Fix-round-1 regression test (Task 7 review, Finding 2): a buffered send
// still sitting in its 700ms window must not be silently dropped if the tab
// closes before the setTimeout fires. live/chat.js registers a `pagehide`
// listener that synchronously flushes chat.pendingSend — this test drives
// that listener directly (via a captured handler) rather than a real
// `unload`, since node has no browser navigation to trigger it.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time; chat.js
// itself reads `window.addEventListener` at module-load time to register
// the pagehide flush) -------------------------------------------------------
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

// A `window` that actually records its listeners, unlike the plain
// `globalThis` alias the other send-buffer tests use — this is the whole
// point of this test file: capture the real 'pagehide' handler chat.js wires
// up, so we can fire it ourselves.
const pagehideListeners = [];
globalThis.window = {
  addEventListener(type, fn) {
    if (type === 'pagehide') pagehideListeners.push(fn);
  },
};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');

function freshState() {
  return {
    draft: '',
    pendingAttach: [],
    live: { chat: { activeId: 'sess-1', model: 'test-model', thread: [] } },
  };
}

test('pagehide flushes a still-buffered send instead of dropping it', async () => {
  assert.strictEqual(pagehideListeners.length, 1, 'chat.js should have registered exactly one pagehide listener at import time');

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
    state.draft = 'closing the tab mid-buffer';

    await actions.send();

    const chat = state.live.chat;
    assert.ok(chat.pendingSend, 'pendingSend should be armed after submit');
    assert.strictEqual(fetchCalls.length, 0, 'nothing hit the network yet — still inside the 700ms buffer');

    // Simulate the tab closing before the 700ms timer ever gets a chance to fire.
    for (const fn of pagehideListeners) fn();

    assert.strictEqual(fetchCalls.length, 1, 'pagehide should flush the buffered send synchronously');
    assert.strictEqual(
      fetchCalls[0].opts.body.get('message'),
      'closing the tab mid-buffer',
      'the flushed POST must carry the buffered message text',
    );
    assert.strictEqual(chat.pendingSend, null, 'pendingSend is cleared once pagehide flushes it');

    // The deferred setTimeout firing later (it wasn't actually cancelled by the
    // real page unload in this simulation) must be a no-op, not a double-send.
    mock.timers.tick(700);
    assert.strictEqual(fetchCalls.length, 1, 'the original 700ms timer must not fire a second POST after pagehide already flushed');
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
  }
});
