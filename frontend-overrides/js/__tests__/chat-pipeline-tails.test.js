// Tasks 4.1 + 4.6 — chat pipeline tails.
//
// Covers:
//   1. Pure: uniqId never collides within the same millisecond (the smallfry
//      rider — 'live-' + Date.now() alone can produce duplicate msgIds).
//   2. Behavioral (4.1): a stale fetchThread resolving AFTER a newer
//      selectSession must not overwrite the newer session's thread.
//   3. Behavioral (4.1): a GENUINE fetchThread failure (not a race) toasts
//      instead of silently leaving the previous session's thread under the
//      new activeId.
//   4. Behavioral (4.6a): an HTTP-level 404 on POST /api/chat_stream
//      finalizes the turn immediately instead of waiting on a 'done' that
//      postStream will never send.
//   5. Behavioral (4.6b): the cross-session notifier suppresses the
//      finished-toast heuristic on a mass simultaneous drop (backend
//      restart) and on the tick right after a poll failure (unknown-length
//      gap) — but still notifies normally for a genuine single finish.
//   6. Behavioral (4.6c): strip-persist timers are keyed per session — a
//      patch in session B must not cancel session A's pending persist.
//   7. Behavioral (4.6d): live tool_output caps at 200 lines, head-trimmed
//      (oldest dropped, most recent kept) — parity with the history path.
//
// Same minimal-browser-shim harness as chat-turn-epoch.test.js (chat.js is a
// browser module; api.js reads `location.origin` at import time).
import { test, mock } from 'node:test';
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
const chatMod = await import('../redesign/live/chat.js');
const { actions } = chatMod;

function freshState(activeId = 'sess-1') {
  return {
    draft: '',
    pendingAttach: [],
    surface: 'chat',
    live: { chat: { activeId, model: 'test-model', thread: [] } },
  };
}

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const drainMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

// A controllable POST /api/chat_stream body — same shape as
// chat-turn-epoch.test.js's makeStream/wireLiveFetch.
function makeStream() {
  const chunks = [];
  let closed = false;
  let error = null;
  let pending = null;
  const settle = () => {
    if (!pending) return;
    const p = pending;
    if (error) { pending = null; p.reject(error); return; }
    if (chunks.length) { pending = null; p.resolve({ done: false, value: chunks.shift() }); return; }
    if (closed) { pending = null; p.resolve({ done: true, value: undefined }); }
  };
  return {
    response: {
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: () => new Promise((resolve, reject) => { pending = { resolve, reject }; settle(); }) }) },
    },
    push(text) { chunks.push(new TextEncoder().encode(text)); settle(); },
    close() { closed = true; settle(); },
    fail(err) { error = err || new Error('stream failed'); settle(); },
  };
}

function wireLiveFetch(streamCalls, streams, routes = {}) {
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/chat_stream')) {
      const s = makeStream();
      streams.push(s);
      streamCalls.push({ url: u, opts });
      return Promise.resolve(s.response);
    }
    for (const [frag, fn] of Object.entries(routes)) {
      if (u.includes(frag)) return Promise.resolve(jsonRes(fn(u, opts)));
    }
    return Promise.resolve(jsonRes({}));
  };
}

// ---- 1. pure: uniqId never collides ----------------------------------------

test('uniqId never collides even when Date.now() repeats across many calls', () => {
  const ids = new Set();
  for (let i = 0; i < 2000; i++) ids.add(chatMod.uniqId('live-'));
  assert.equal(ids.size, 2000, 'every id must be unique regardless of millisecond collisions');
});

test('uniqId keeps the given prefix and a stable shape', () => {
  const id = chatMod.uniqId('live-u-');
  assert.match(id, /^live-u-\d+-\d+$/);
});

// ---- 2. session-switch staleness: stale resolve must not win (4.1) --------

test('a stale fetchThread resolving AFTER a newer selectSession must not overwrite the newer session\'s thread', async () => {
  const state = freshState('sess-a');
  runtime.state = state;
  const chat = state.live.chat;

  let resolveA;
  const pendingA = new Promise((res) => { resolveA = res; });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/history/sess-a')) {
      return pendingA.then(() => jsonRes({ history: [{ role: 'user', content: 'from A' }] }));
    }
    if (u.includes('/api/history/sess-b')) {
      return Promise.resolve(jsonRes({ history: [{ role: 'user', content: 'from B' }] }));
    }
    return Promise.resolve(jsonRes({}));
  };
  runtime.render = () => {};
  try {
    const p1 = actions.selectSession('sess-a');   // awaits fetchThread(sess-a) — hangs on pendingA
    await drainMicrotasks();
    const p2 = actions.selectSession('sess-b');   // supersedes — its own fetchThread resolves immediately
    await p2;
    await drainMicrotasks();

    assert.equal(chat.activeId, 'sess-b');
    assert.ok(chat.thread.some((m) => m.text === 'from B'), 'B\'s thread is showing');

    resolveA();   // the stale A fetch finally resolves
    await p1;
    await drainMicrotasks();

    assert.equal(chat.activeId, 'sess-b', 'still on B');
    assert.ok(!chat.thread.some((m) => m.text === 'from A'),
      'the stale A response must not have overwritten B\'s thread');
    assert.ok(chat.thread.some((m) => m.text === 'from B'), 'B\'s thread is still what\'s on screen');
  } finally {
    delete globalThis.fetch;
  }
});

// ---- 3. a GENUINE failure (not a race) toasts (4.1) ------------------------

test('a genuine fetchThread failure toasts instead of silently leaving the old thread under the new activeId', async () => {
  // toast()'s own auto-dismiss (a real 4500ms setTimeout) would otherwise
  // dangle past this test's end and fire during a LATER test — fake it and
  // fast-forward past it before returning.
  mock.timers.enable({ apis: ['setTimeout'] });
  const toasts = [];
  const msgNode = {};
  Object.defineProperty(msgNode, 'textContent', {
    get() { return this._t; },
    set(v) { this._t = v; toasts.push(v); },
  });
  const savedDocument = globalThis.document;
  globalThis.document = {
    querySelector: () => null,
    getElementById: () => null,
    createElement: () => ({
      classList: { add() {}, remove() {} },
      style: {},
      appendChild() {},
      addEventListener() {},
      remove() {},
      querySelector: (sel) => (sel === '.oc-toast-msg' ? msgNode : null),
    }),
    body: { appendChild() {} },
  };
  try {
    const state = freshState('sess-old');
    runtime.state = state;
    const chat = state.live.chat;
    chat.thread = [{ id: 'old-1', role: 'user', text: 'previous session content' }];
    chat.title = 'Old Session';

    globalThis.fetch = (url) => {
      const u = String(url);
      if (u.includes('/api/history/sess-new')) return Promise.reject(new Error('offline'));
      return Promise.resolve(jsonRes({}));
    };
    runtime.render = () => {};

    await actions.selectSession('sess-new');
    await drainMicrotasks();

    assert.equal(chat.activeId, 'sess-new', 'the switch itself is not blocked by the failed fetch');
    assert.ok(chat.thread.some((m) => m.text === 'previous session content'),
      'nothing cleared the old thread — it would render under the NEW activeId with no other sign of failure');
    assert.ok(toasts.some((t) => /couldn.t load/i.test(t)), 'a toast explains the failed load');
    mock.timers.tick(5000);   // fast-forward the toast's auto-dismiss, then drop it
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
    globalThis.document = savedDocument;
  }
});

// ---- 4. got404 dead-end: finalize immediately (4.6a) -----------------------

test('an HTTP-level 404 on POST /api/chat_stream finalizes the turn immediately, not after a done that never comes', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const state = freshState('sess-1');
  runtime.state = state;
  const chat = state.live.chat;
  const origReload = actions.reloadSessions;
  let reloadCalled = 0;
  actions.reloadSessions = async () => { reloadCalled++; };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/chat_stream')) {
      return Promise.resolve({ ok: false, status: 404, headers: { get: () => '' } });
    }
    return Promise.resolve(jsonRes({}));
  };
  runtime.render = () => {};
  try {
    state.draft = 'hello';
    await actions.send();
    mock.timers.tick(700);
    await drainMicrotasks();

    assert.equal(reloadCalled, 1,
      'reloadSessions fired synchronously off the error frame, not after the 25s hb watchdog');
    assert.ok(!chat.thread.some((m) => m.role === 'assistant' && m.error),
      'no "No response from this model" notice — got404 short-circuits it, same as before this fix');
  } finally {
    actions.reloadSessions = origReload;
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 5. restart-notify heuristic (4.6b) ------------------------------------

test('notifier: a mass simultaneous drop and a just-reconnected poll suppress finished-toasts; a genuine single finish still notifies', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let activeSessions = [];
  let failNext = false;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/chat/active_sessions')) {
      if (failNext) { failNext = false; return Promise.reject(new Error('network blip')); }
      return Promise.resolve(jsonRes({ active: activeSessions }));
    }
    return Promise.resolve(jsonRes({}));
  };
  runtime.render = () => {};
  try {
    // Never matches any polled session id, so _isViewing() is always false —
    // every drop is eligible to notify unless the heuristic suppresses it.
    const state = freshState('sess-x');
    runtime.state = state;

    // ---- Phase 1: mass collapse (e.g. a backend restart) ----
    activeSessions = ['s1', 's2', 's3'];
    await chatMod.load(state);   // first tick: nothing was previously active
    await drainMicrotasks();
    const chat = state.live.chat;
    assert.equal(chat.notified.size, 0);

    activeSessions = [];         // all three vanish in the SAME tick
    mock.timers.tick(4000);
    await drainMicrotasks();
    assert.equal(chat.notified.size, 0,
      'a mass simultaneous drop must not be read as 3 legitimate finishes');

    // ---- Phase 2: a genuine single finish still notifies ----
    activeSessions = ['s4', 's5'];
    mock.timers.tick(4000);      // both become active (arrivals, not drops)
    await drainMicrotasks();
    activeSessions = ['s5'];     // only s4 finishes
    mock.timers.tick(4000);
    await drainMicrotasks();
    assert.ok(chat.notified.has('s4'), 'a genuine single-session finish still notifies');

    // ---- Phase 3: a poll that just recovered from a failure can't trust its drop ----
    activeSessions = ['s6'];
    mock.timers.tick(4000);      // s6 becomes active
    await drainMicrotasks();
    failNext = true;
    mock.timers.tick(4000);      // this poll fails outright
    await drainMicrotasks();
    activeSessions = [];         // s6 is gone by the time the feed recovers
    mock.timers.tick(4000);      // reconnect tick
    await drainMicrotasks();
    assert.ok(!chat.notified.has('s6'),
      'the reconnect tick cannot trust the drop — it may just be the outage window');
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 6. strip-persist timers keyed per session (4.6c) ----------------------

test('strip persist timers are keyed per session — a patch in B must not cancel A\'s pending persist', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const streamCalls = [];
  const streams = [];
  const stripCalls = [];
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/chat_stream')) {
      const s = makeStream();
      streams.push(s);
      streamCalls.push({ url: u, opts });
      return Promise.resolve(s.response);
    }
    if (u.includes('/api/strip/state')) {
      stripCalls.push(opts.body.get('session'));
      return Promise.resolve(jsonRes({}));
    }
    return Promise.resolve(jsonRes({}));
  };
  runtime.render = () => {};
  try {
    const state = freshState('sess-a');
    runtime.state = state;
    const chat = state.live.chat;

    // A's turn goes live and schedules A's persist timer — flushPending
    // directly (skipping the 700ms compose buffer) so no virtual time
    // elapses before B's own patch lands, genuinely racing the two.
    state.draft = 'go a';
    await actions.send();
    chatMod.flushPending('sess-a');
    await drainMicrotasks();
    streams[0].push('data: {"type":"tool_start","tool":"Bash","tool_id":"t1"}\n\n');
    await drainMicrotasks();

    // Switch to B — still at virtual t=0 — and patch its strip too.
    await actions.selectSession('sess-b');
    await drainMicrotasks();
    state.draft = 'go b';
    await actions.send();
    chatMod.flushPending('sess-b');
    await drainMicrotasks();
    streams[1].push('data: {"type":"tool_start","tool":"Bash","tool_id":"t2"}\n\n');
    await drainMicrotasks();

    // Elapse the 500ms debounce for both.
    mock.timers.tick(500);
    await drainMicrotasks();

    assert.ok(stripCalls.includes('sess-a'),
      'A\'s pending persist must still fire — B\'s later patch must not have cancelled it');
    assert.ok(stripCalls.includes('sess-b'), '...alongside B\'s own persist');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 7. live tool_output caps at 200 lines, head-trimmed (4.6d) -----------

test('live tool_output caps at 200 lines and head-trims — oldest dropped, most recent kept', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const streamCalls = [];
  const streams = [];
  wireLiveFetch(streamCalls, streams);
  runtime.render = () => {};
  try {
    const state = freshState('sess-1');
    runtime.state = state;
    const chat = state.live.chat;

    state.draft = 'run something chatty';
    await actions.send();
    mock.timers.tick(700);
    await drainMicrotasks();

    streams[0].push('data: {"type":"tool_start","tool":"Bash","tool_id":"t1"}\n\n');
    await drainMicrotasks();

    const lines = [];
    for (let i = 0; i < 250; i++) lines.push(`line-${i}`);
    const payload = JSON.stringify({ type: 'tool_output', tool_id: 't1', output: lines.join('\n') });
    streams[0].push(`data: ${payload}\n\n`);
    await drainMicrotasks();

    const asst = chat.thread.find((m) => m.role === 'assistant');
    const step = asst.activity.steps.find((s) => s.kind !== 'think');
    assert.equal(step.lines.length, 200, 'capped at the same 200-line ceiling as the history path');
    assert.equal(step.lines[0].t, 'line-50', 'head-trimmed — the oldest 50 lines were dropped');
    assert.equal(step.lines[199].t, 'line-249', 'the most recent line is kept');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});
