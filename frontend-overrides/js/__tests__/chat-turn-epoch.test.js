// Task 1.3 — chat turn-identity cluster.
//
// Covers:
//   1. Pure per-turn epoch guard (isCurrentTurn) — the check every beginTurn
//      closure runs so a STALE source (aborted POST reader, superseded
//      EventSource) can never deliver its trailing error into a successor turn.
//   2. Pure session-keyed queue helpers (queueHead/queueTake/queueDropSession).
//   3. Behavioral: flushPending's busy-gate — a second send flushed while a
//      turn is live for the SAME session diverts to the queue instead of
//      firing a concurrent POST (backend would reject busy_stream after the
//      first turn's reader was already aborted — both turns wrecked).
//   4. Behavioral: the stale AbortError from a superseded POST reader is
//      dropped by the epoch guard instead of putting a false "connection
//      dropped" bubble on the fresh turn and tearing it down.
//   5. Behavioral: chat.queuedList is a session-keyed ARRAY (second queue
//      doesn't overwrite the first) and newChat clears the leaving session's
//      entries.
//   6. Behavioral: send() with a failed session-create restores the draft
//      instead of silently losing the message.
//   7. Behavioral: stopRun clears the bubble's streaming flag.
//
// live/chat.js is a browser module (fetch/location/DOM), so this test stubs
// the minimum browser surface it touches — same pattern as
// redesign-send-buffer.test.js. Module-level state (the `turn` slot) persists
// across tests in this file, so each behavioral test tears down via stopRun.
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
const chatMod = await import('../redesign/live/chat.js');
const { actions } = chatMod;

function freshState(activeId = 'sess-1') {
  return {
    draft: '',
    pendingAttach: [],
    live: { chat: { activeId, model: 'test-model', thread: [] } },
  };
}

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

// fetch mock: /api/chat_stream hangs forever (a streaming POST in flight) and
// rejects with an AbortError when its signal aborts — exactly what a real
// aborted reader does. Everything else resolves to empty JSON.
function wireStreamingFetch(streamCalls) {
  globalThis.fetch = (url, opts) => {
    if (String(url).includes('/api/chat_stream')) {
      streamCalls.push({ url, opts });
      return new Promise((resolve, reject) => {
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort',
            () => reject(new DOMException('The operation was aborted.', 'AbortError')));
        }
      });
    }
    return Promise.resolve(jsonRes({}));
  };
}

const drainMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

// ---- 1. pure epoch guard ----------------------------------------------------

test('isCurrentTurn: matches only the live turn slot with the captured epoch', () => {
  assert.equal(chatMod.isCurrentTurn(null, 1), false, 'torn-down turn → stale');
  assert.equal(chatMod.isCurrentTurn(undefined, 1), false);
  assert.equal(chatMod.isCurrentTurn({ epoch: 1 }, 1), true, 'same epoch → current');
  assert.equal(chatMod.isCurrentTurn({ epoch: 2 }, 1), false, 'successor turn → stale closure');
  assert.equal(chatMod.isCurrentTurn({}, undefined), false, 'no epochs at all is never current');
});

// ---- 2. pure session-keyed queue helpers -------------------------------------

test('queueHead returns the first entry for the session, null otherwise', () => {
  const list = [{ sid: 'b', text: '1' }, { sid: 'a', text: '2' }, { sid: 'a', text: '3' }];
  assert.deepEqual(chatMod.queueHead(list, 'a'), { sid: 'a', text: '2' });
  assert.equal(chatMod.queueHead(list, 'zzz'), null);
  assert.equal(chatMod.queueHead(null, 'a'), null);
});

test('queueTake removes exactly the first entry for the session', () => {
  const list = [{ sid: 'b', text: '1' }, { sid: 'a', text: '2' }, { sid: 'a', text: '3' }];
  const { taken, rest } = chatMod.queueTake(list, 'a');
  assert.deepEqual(taken, { sid: 'a', text: '2' });
  assert.deepEqual(rest, [{ sid: 'b', text: '1' }, { sid: 'a', text: '3' }]);
  const miss = chatMod.queueTake(rest, 'zzz');
  assert.equal(miss.taken, null);
  assert.deepEqual(miss.rest, rest);
});

test('queueDropSession filters every entry for the session', () => {
  const list = [{ sid: 'b', text: '1' }, { sid: 'a', text: '2' }, { sid: 'a', text: '3' }];
  assert.deepEqual(chatMod.queueDropSession(list, 'a'), [{ sid: 'b', text: '1' }]);
  assert.deepEqual(chatMod.queueDropSession(null, 'a'), []);
});

// ---- 3. flushPending busy-gate -----------------------------------------------

test('second send inside the 700ms buffer queues instead of firing a concurrent POST', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  wireStreamingFetch(streamCalls);
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    // First message buffers, second send flushes it (turn goes live) and
    // claims its own buffer window.
    state.draft = 'first';
    await actions.send();
    state.draft = 'second';
    await actions.send();
    assert.equal(streamCalls.length, 1, 'the first message is streaming');

    // The second window elapses while the first turn is STILL live for this
    // session → must divert to the queue, not fire POST #2.
    mock.timers.tick(700);
    assert.equal(streamCalls.length, 1, 'no concurrent POST for the same session');
    assert.equal(chat.pendingSend, null);
    const q = chatMod.queueHead(chat.queuedList, 'sess-1');
    assert.ok(q, 'the second message is queued for its session');
    assert.equal(q.text, 'second');
    assert.equal(chat.queued && chat.queued.text, 'second', 'composer banner view reflects it');
    assert.ok(!chat.thread.some((m) => m.role === 'user' && m.text === 'second'),
      'the optimistic bubble left the thread (it renders in the queued banner instead)');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 4. epoch guard drops a superseded reader's AbortError --------------------

test('stale AbortError from a superseded POST reader never wrecks the successor turn', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  wireStreamingFetch(streamCalls);
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    // Turn live in sess-1.
    state.draft = 'first';
    await actions.send();
    mock.timers.tick(700);
    assert.equal(streamCalls.length, 1);

    // A send lands for ANOTHER session while sess-1's reader is mid-stream:
    // fireSend does stopLive() (aborting reader #1) + beginTurn() in the same
    // synchronous frame, so reader #1's AbortError lands AFTER turn #2 exists.
    chat.activeId = 'sess-2';
    state.draft = 'other';
    await actions.send();
    mock.timers.tick(700);
    assert.equal(streamCalls.length, 2, 'the new session send fired');

    await drainMicrotasks(); // deliver reader #1's queued AbortError

    const last = chat.thread[chat.thread.length - 1];
    assert.equal(last.role, 'assistant', 'the fresh turn bubble is the last message');
    assert.ok(!last.error, 'no false "connection dropped" error on the healthy turn');
    assert.ok(!last.notice, 'no stale notice text either');

    // The successor turn is still alive: another send for sess-2 queues
    // behind it (a torn-down turn would buffer a pendingSend instead).
    state.draft = 'follow';
    await actions.send();
    const q = chatMod.queueHead(chat.queuedList, 'sess-2');
    assert.ok(q && q.text === 'follow', 'turn survived the stale error — send queued behind it');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 5. session-keyed queue array + newChat clearing ---------------------------

test('queued messages accumulate per session and newChat clears the leaving session', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  wireStreamingFetch(streamCalls);
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    state.draft = 'first';
    await actions.send();
    mock.timers.tick(700);   // turn live for sess-1

    state.draft = 'q1';
    await actions.send();
    state.draft = 'q2';
    await actions.send();

    const mine = (chat.queuedList || []).filter((q) => q.sid === 'sess-1');
    assert.equal(mine.length, 2, 'second queued message must not overwrite the first');
    assert.deepEqual(mine.map((q) => q.text), ['q1', 'q2']);

    actions.newChat();
    await drainMicrotasks();
    assert.equal((chat.queuedList || []).filter((q) => q.sid === 'sess-1').length, 0,
      'newChat clears the leaving session\'s queued messages');
    assert.ok(!chat.queued, 'banner view cleared too');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 6. send() restores the draft when session-create fails --------------------

test('offline first send in a new chat restores the draft instead of losing it', async () => {
  globalThis.fetch = () => Promise.reject(new Error('offline'));
  runtime.render = () => {};
  try {
    const state = freshState(null);   // brand-new chat, no session yet
    runtime.state = state;
    state.draft = 'hello there';
    state.pendingAttach = [{ id: 'att1', name: 'x.png' }];

    await actions.send();

    assert.equal(state.draft, 'hello there', 'draft restored after failed session create');
    assert.deepEqual(state.pendingAttach, [{ id: 'att1', name: 'x.png' }], 'attachments restored');
    assert.equal(state.live.chat.thread.length, 0, 'no orphan optimistic bubble');
    assert.ok(!state.live.chat.pendingSend, 'nothing left armed');
  } finally {
    delete globalThis.fetch;
  }
});

// ---- 7. stopRun clears the streaming flag ---------------------------------------

test('stopRun clears the bubble streaming flag so the caret stops blinking', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  wireStreamingFetch(streamCalls);
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    state.draft = 'hi';
    await actions.send();
    mock.timers.tick(700);   // turn live, assistant bubble mounted by ensureActivity

    const bubble = chat.thread.find((m) => m.role === 'assistant');
    assert.ok(bubble, 'live assistant bubble exists');
    bubble.streaming = true; // as a prose delta would have left it

    actions.stopRun();
    await drainMicrotasks();

    assert.equal(bubble.streaming, false, 'stopRun must clear the streaming caret');
    assert.match(String(bubble.activity && bubble.activity.worked || ''), /^Stopped after /);
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
  }
});
