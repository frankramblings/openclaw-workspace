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
//   8. Behavioral (I1): a buffered send flushed AFTER a thread switch diverts
//      to its own session's queue instead of firing into the viewed thread.
//   9. Behavioral (M5+M1): stopRun stops the TURN's session (not the viewed
//      one) and never recalls another thread's queue into the draft; same
//      keying for the turn error handler's queued-rescue.
//  10. Behavioral (I2): a message queued in A stays intact while B runs and
//      finishes, then fires when A is reselected.
//  11. Behavioral (I3): after a Stop whose POST failed, the notifier re-attach
//      replaces the stopped bubble instead of minting a duplicate; a
//      SUCCESSFUL stop instead clears the dedupe record, so an unrelated
//      later re-attach in that session never touches the finished bubble
//      (Review round 2, Important 2).
//  12. Behavioral (Review round 2, Important 1): a pagehide flush for a
//      DIFFERENT session than the one on screen fires exactly one
//      fire-and-forget keepalive POST and opens no local turn state — no
//      assistant bubble in the viewed thread, nothing queued either (that
//      would double-send on resume).
//  13. Behavioral (Review round 2, Minor 6): cancelMobileEdit's cross-session
//      Cancel routed through the REAL queueForSession (not a stub) lands in
//      chat.queuedList with the right shape, and reselecting that session
//      fires it through the normal queue plumbing.
//
// live/chat.js is a browser module (fetch/location/DOM), so this test stubs
// the minimum browser surface it touches — same pattern as
// redesign-send-buffer.test.js. Module-level state (the `turn` slot) persists
// across tests in this file, so each behavioral test tears down via stopRun.
import { test, mock } from 'node:test';
import assert from 'node:assert';
import { editPendingOnMobile, cancelMobileEdit } from '../redesign/mobile/edit-flow.js';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time) ------------
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
// attachTurn tails via EventSource; a bare stub is enough (frames are fed
// through the replay path in these tests, never the live tail).
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

// A controllable POST /api/chat_stream body: the test decides when frames
// arrive (push), when the stream ends cleanly (close → postStream emits
// 'done'), or when the pipe dies (fail → postStream's catch emits 'error').
// postStream reads sequentially, so one pending read at a time is enough.
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

// fetch mock for the multi-endpoint scenarios: chat_stream POSTs get a fresh
// makeStream (recorded in `streams` / `streamCalls`), any fragment listed in
// `routes` resolves to its function's JSON, everything else to empty JSON.
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

// ---- 8. flushPending view gate (I1) ------------------------------------------

test('a buffered send flushed after a thread switch queues for its own session, never fires into the viewed thread', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  const streams = [];
  wireLiveFetch(streamCalls, streams);
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    // Message buffered for sess-1; the user switches threads INSIDE the 700ms
    // window (selectSession replaces the thread array and flips activeId).
    state.draft = 'switcher';
    await actions.send();
    assert.ok(chat.pendingSend, 'send is sitting in its buffer window');
    chat.activeId = 'sess-2';
    chat.thread = [];

    // Buffer elapses. Firing now would beginTurn against the CURRENT view —
    // the assistant bubble would land in sess-2's displayed thread.
    mock.timers.tick(700);
    assert.equal(streamCalls.length, 0, 'no POST fired into the wrong view');
    assert.equal(chat.pendingSend, null);
    const q = chatMod.queueHead(chat.queuedList, 'sess-1');
    assert.ok(q && q.text === 'switcher', 'message queued for ITS OWN session');
    assert.ok(!chat.thread.some((m) => m.role === 'assistant'),
      'no assistant bubble pushed into the viewed thread');
    assert.equal(chat.queued, null, 'sess-2\'s banner view stays empty');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 9a. stopRun stops the TURN's session + leaves other queues alone (M5+M1) --

test('stopRun POSTs stop for the turn\'s session and never recalls the viewed thread\'s queue', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  const streams = [];
  const stopCalls = [];
  wireLiveFetch(streamCalls, streams, {
    '/api/chat/stop/': (u) => { stopCalls.push(u); return {}; },
  });
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    state.draft = 'first';
    await actions.send();
    mock.timers.tick(700);           // turn live for sess-1
    await drainMicrotasks();
    state.draft = 'qa';
    await actions.send();            // queued for sess-1 behind its live turn

    // The user is now looking at sess-2, which has its own queued entry and
    // an in-progress draft.
    chat.activeId = 'sess-2';
    chat.queuedList = [...chat.queuedList, { sid: 'sess-2', text: 'qb', attachSnap: [] }];
    chat.queued = { sid: 'sess-2', text: 'qb', attachSnap: [] };
    state.draft = 'viewer typing';

    actions.stopRun();
    await drainMicrotasks();

    assert.equal(stopCalls.length, 1, 'exactly one stop POST');
    assert.match(stopCalls[0], /\/api\/chat\/stop\/sess-1$/,
      'stop must land on the RUNNING turn\'s session, not the viewed one');
    assert.equal(state.draft, 'viewer typing', 'viewed thread\'s draft untouched');
    assert.ok(chatMod.queueHead(chat.queuedList, 'sess-1'), 'stopped session\'s entry stays queued');
    assert.ok(chatMod.queueHead(chat.queuedList, 'sess-2'), 'viewed session\'s entry stays queued');
  } finally {
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 9b. turn error handler's queued-rescue keyed by the erroring session (M1) --

test('a turn erroring in a background thread never recalls the viewed thread\'s queue into the draft', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  const streams = [];
  wireLiveFetch(streamCalls, streams);
  runtime.render = () => {};
  try {
    const state = freshState();
    runtime.state = state;
    const chat = state.live.chat;

    state.draft = 'first';
    await actions.send();
    mock.timers.tick(700);           // turn live for sess-1
    await drainMicrotasks();         // postStream reader attached
    state.draft = 'qa';
    await actions.send();            // queued for sess-1

    chat.activeId = 'sess-2';
    chat.queuedList = [...chat.queuedList, { sid: 'sess-2', text: 'qb', attachSnap: [] }];
    chat.queued = { sid: 'sess-2', text: 'qb', attachSnap: [] };
    state.draft = 'viewer typing';

    streams[0].fail(new Error('pipe died'));   // sess-1's turn errors
    await drainMicrotasks();

    assert.equal(state.draft, 'viewer typing',
      'error in sess-1 must not clobber the draft while viewing sess-2');
    assert.ok(chatMod.queueHead(chat.queuedList, 'sess-2'), 'viewed session\'s queue intact');
    assert.ok(chatMod.queueHead(chat.queuedList, 'sess-1'),
      'erroring session\'s entry stays queued for its own thread');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 10. cross-session queue survival (I2) -------------------------------------

test('a message queued in A survives B\'s turn completing and fires when A is reselected', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  const streams = [];
  wireLiveFetch(streamCalls, streams);
  runtime.render = () => {};
  try {
    const state = freshState('sess-a');
    runtime.state = state;
    const chat = state.live.chat;

    // Turn live in A, then a follow-up queues behind it.
    state.draft = 'first';
    await actions.send();
    mock.timers.tick(700);
    await drainMicrotasks();
    assert.equal(streamCalls.length, 1);
    state.draft = 'queued-a';
    await actions.send();
    assert.ok(chatMod.queueHead(chat.queuedList, 'sess-a'));

    // Switch to B (full selectSession: detaches A's reader, nulls the turn).
    await actions.selectSession('sess-b');
    await drainMicrotasks();

    // A turn runs in B and completes.
    state.draft = 'b-msg';
    await actions.send();
    mock.timers.tick(700);
    await drainMicrotasks();
    assert.equal(streamCalls.length, 2, 'B\'s own send fired');
    streams[1].push('data: [DONE]\n\n');
    await drainMicrotasks();

    // B finishing must not touch A's queue — and must not fire A's message.
    assert.equal(streamCalls.length, 2, 'no POST fired for A\'s queued entry');
    const still = chatMod.queueHead(chat.queuedList, 'sess-a');
    assert.ok(still && still.text === 'queued-a', 'A\'s entry intact after B\'s turn ended');

    // Reselecting A fires it through the normal queue plumbing.
    await actions.selectSession('sess-a');
    await drainMicrotasks();
    assert.equal(streamCalls.length, 3, 'A\'s queued message fired on reselect');
    assert.equal(streamCalls[2].opts.body.get('message'), 'queued-a');
    assert.equal(streamCalls[2].opts.body.get('session'), 'sess-a');
    assert.equal(chatMod.queueHead(chat.queuedList, 'sess-a'), null, 'queue drained');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 11. stop-dedupe record lifecycle (I3 + Review round 2 Important 2) --------
//
// The notifier's re-attach-on-active-again path is the ONLY testable way to
// drive attachTurn from outside the module (reconcileTurn/attachTurn aren't
// exported), and load()'s startNotifier() is a MODULE-LEVEL singleton whose
// setInterval handle does NOT survive a mock.timers.reset()/re-enable() cycle
// (verified empirically — a second test calling load() in a fresh mock.timers
// session never gets its notifier tick to fire). So both the FAILED-stop and
// SUCCESSFUL-stop scenarios have to share one mock.timers session — hence one
// test, two phases, instead of two independent tests.

test('stop-dedupe record: a FAILED stop keeps it (dedupe fires on re-attach); a SUCCESSFUL stop clears it (dedupe must NOT fire for an unrelated later turn)', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  const streams = [];
  let activeSessions = [];
  let turnSnap = { active: false };
  // Whether /api/chat/stop/<id> succeeds or fails THIS phase. wireLiveFetch's
  // jsonRes() always resolves ok:true, which can't represent the 502 apiForm
  // throws on when backend/app.py's stop_chat catches a gateway_call failure
  // — so the stop route is handled here instead of via wireLiveFetch's routes.
  let stopOk = false;
  wireLiveFetch(streamCalls, streams, {
    '/api/chat/active_sessions': () => ({ active: activeSessions }),
    '/api/chat/turn': () => turnSnap,
  });
  const baseFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => {
    if (String(url).includes('/api/chat/stop/')) {
      return Promise.resolve(stopOk
        ? { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, runIds: ['r1'] }), text: async () => '{}' }
        : { ok: false, status: 502, headers: { get: () => 'application/json' }, json: async () => ({ ok: false }), text: async () => '{}' });
    }
    return baseFetch(url, opts);
  };
  runtime.render = () => {};
  try {
    const state = freshState('sess-1');
    runtime.state = state;
    // load() starts the cross-session notifier — the exact path that re-attaches
    // ~4s after a stop whose POST never actually killed the server-side run.
    await chatMod.load(state);
    const chat = state.live.chat;
    await drainMicrotasks();

    // ---- Phase 1 (I3, unchanged): the stop POST FAILS (502 — the gateway
    // call itself threw). The run is still live server-side, so the
    // notifier's re-attach must dedupe: replace the stopped bubble instead of
    // duplicating it.
    stopOk = false;
    state.draft = 'hello';
    await actions.send();
    mock.timers.tick(700);
    await drainMicrotasks();
    assert.equal(streamCalls.length, 1);
    streams[0].push('data: {"delta":"Partial answer"}\n\n');
    await drainMicrotasks();

    actions.stopRun();
    await drainMicrotasks();
    let stopped = chat.thread.filter((m) => m.role === 'assistant');
    assert.equal(stopped.length, 1);
    assert.match(stopped[0].text, /Partial answer/, 'stop flushed the buffered text');
    const stoppedMsg = stopped[0];   // object identity — msgIds can collide within one ms

    turnSnap = {
      active: true,
      elapsed_ms: 9000,
      last_event_id: '2',
      events: [
        { id: '1', data: 'data: {"delta":"Partial answer"}\n\n' },
        { id: '2', data: 'data: {"delta":" — and more"}\n\n' },
      ],
    };
    activeSessions = ['sess-1'];
    mock.timers.tick(4000);
    await drainMicrotasks();

    let asst = chat.thread.filter((m) => m.role === 'assistant');
    assert.equal(asst.length, 1,
      'a FAILED stop must still dedupe on re-attach — one bubble, not a duplicate');
    assert.notEqual(asst[0], stoppedMsg, 'the replayed rebuild owns the slot');

    // Tear down phase 1's live replay before phase 2 starts a new session.
    actions.stopRun();
    await drainMicrotasks();
    turnSnap = { active: false };
    activeSessions = [];

    // ---- Phase 2 (Review round 2, Important 2): a DIFFERENT session's turn
    // is stopped SUCCESSFULLY (the gateway confirmed the abort — a genuinely
    // finished turn, nothing left running). Later, an UNRELATED
    // server-initiated turn starts in that SAME session (e.g. a follow-up
    // promise firing) and the notifier re-attaches. A stale dedupe record
    // must not delete the finished Stop bubble — it belongs to a different,
    // already-finished exchange.
    chat.activeId = 'sess-2';
    chat.thread = [];
    stopOk = true;
    state.draft = 'second session';
    await actions.send();
    mock.timers.tick(700);
    await drainMicrotasks();
    assert.equal(streamCalls.length, 2, 'sess-2\'s own send fired');
    streams[1].push('data: {"delta":"First reply"}\n\n');
    await drainMicrotasks();

    actions.stopRun();
    await drainMicrotasks();   // let the successful stop POST's .then() settle
    stopped = chat.thread.filter((m) => m.role === 'assistant');
    assert.equal(stopped.length, 1);
    const stoppedMsg2 = stopped[0];
    assert.match(String(stoppedMsg2.activity && stoppedMsg2.activity.worked || ''), /^Stopped after /);

    turnSnap = {
      active: true,
      elapsed_ms: 0,
      last_event_id: '1',
      events: [{ id: '1', data: 'data: {"delta":"A fresh, unrelated reply"}\n\n' }],
    };
    activeSessions = ['sess-2'];
    mock.timers.tick(4000);
    await drainMicrotasks();

    asst = chat.thread.filter((m) => m.role === 'assistant');
    assert.equal(asst.length, 2,
      'a successful stop must clear the dedupe record — the finished Stop bubble survives an unrelated later re-attach');
    assert.ok(asst.includes(stoppedMsg2), 'the original stopped bubble is untouched, same object');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---- 12. pagehide cross-session flush: keepalive only, no local turn (Review
// round 2, Important 1) ------------------------------------------------------

test('a pagehide flush for a session OTHER than the one on screen fires exactly one keepalive POST and opens no local turn state', async () => {
  const streamCalls = [];
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    if (u.includes('/api/chat_stream')) {
      streamCalls.push({ url: u, opts });
      // Fire-and-forget: the keepalive path never reads the response body.
      return Promise.resolve({ ok: true, status: 200, headers: { get: () => '' } });
    }
    return Promise.resolve({ ok: true, headers: { get: () => 'application/json' }, json: async () => ({}), text: async () => '{}' });
  };
  runtime.render = () => {};
  try {
    const state = freshState('sess-2');   // the user has switched to sess-2...
    runtime.state = state;
    const chat = state.live.chat;
    chat.thread = [{ id: 'u-viewed', role: 'user', text: 'viewed thread', time: '' }];
    // ...while sess-1's buffered send is still sitting in its window.
    chat.pendingSend = {
      messageId: 'pend-1', text: 'background msg', attachSnap: [], sessionId: 'sess-1',
      deadline: Date.now(), timerId: 0,
    };

    chatMod.flushPending('sess-1', { pagehide: true });
    await drainMicrotasks();

    assert.equal(streamCalls.length, 1, 'exactly one keepalive POST fired');
    assert.equal(streamCalls[0].opts.method, 'POST');
    assert.equal(streamCalls[0].opts.keepalive, true,
      'must use fetch keepalive so the request survives the page tearing down/backgrounding');
    assert.equal(streamCalls[0].opts.body.get('session'), 'sess-1');
    assert.equal(streamCalls[0].opts.body.get('message'), 'background msg');

    assert.equal(chat.thread.some((m) => m.role === 'assistant'), false,
      'no assistant bubble bound into the viewed (sess-2) thread — beginTurn never ran');
    assert.equal(chat.thread.some((m) => m.id === 'pend-1'), false,
      'the optimistic bubble for the backgrounded session is gone from the viewed thread');
    assert.equal(chatMod.queueHead(chat.queuedList, 'sess-1'), null,
      'not also queued — the server already has the turn; queuing too would double-send on resume');
    assert.equal(chat.pendingSend, null, 'pendingSend consumed');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    delete globalThis.fetch;
  }
});

// ---- 13. cancelMobileEdit cross-session Cancel through the REAL
// queueForSession (Review round 2, Minor 6) ----------------------------------

test('cancelMobileEdit after a session switch queues through the real queueForSession, and reselecting fires it', async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const streamCalls = [];
  const streams = [];
  wireLiveFetch(streamCalls, streams);
  runtime.render = () => {};
  try {
    const state = freshState('sess-1');
    runtime.state = state;
    const chat = state.live.chat;

    // A buffered send is being edited on mobile...
    chat.thread = [{ id: 'u1', role: 'user', text: 'edited text', _optimistic: true, _deadline: Date.now() + 700 }];
    chat.pendingSend = { messageId: 'u1', text: 'edited text', attachSnap: [], sessionId: 'sess-1', timerId: 0 };
    editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
    assert.ok(state.mobileEditingPending, 'edit snapshot captured');

    // ...then the user switches to a different thread before hitting Cancel.
    chat.activeId = 'sess-2';

    cancelMobileEdit(state, {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      flush: chatMod.flushPending,
      queue: chatMod.queueForSession,   // the REAL production hook, not a stub
    });

    assert.equal(chat.pendingSend, null, 'not re-armed for the viewed thread');
    assert.ok(!chat.thread.some((m) => m.id === 'u1'),
      'nothing spliced into sess-2\'s viewed thread');
    const q = chatMod.queueHead(chat.queuedList, 'sess-1');
    assert.deepEqual(q, { sid: 'sess-1', text: 'edited text', attachSnap: [] },
      'entry lands in queuedList with the correct shape');

    // Reselecting sess-1 fires it through the normal queue plumbing
    // (selectSession → flushQueuedFor).
    await actions.selectSession('sess-1');
    await drainMicrotasks();

    assert.equal(streamCalls.length, 1, 'the queued edit fired on reselect');
    assert.equal(streamCalls[0].opts.body.get('message'), 'edited text');
    assert.equal(streamCalls[0].opts.body.get('session'), 'sess-1');
    assert.equal(chatMod.queueHead(chat.queuedList, 'sess-1'), null, 'queue drained');
  } finally {
    actions.stopRun();
    await drainMicrotasks();
    mock.timers.reset();
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
// Rider (task-w6): shouldSuppressFinishedToasts — the pure decision behind
// the cross-session notifier's restart-noise heuristic (_notifyTick). A
// backend restart clears every in-flight turn in the same poll tick, which
// looks identical to N simultaneous genuine completions from the poll's
// shape alone — but exactly 1-2 simultaneous finishes (not a reconnect) are
// common enough on an ordinary multi-thread day that suppressing them costs
// more than the rare false positive of a small restart getting toasted.
// ---------------------------------------------------------------------------

test('shouldSuppressFinishedToasts: a single genuine finish is never suppressed', () => {
  assert.equal(chatMod.shouldSuppressFinishedToasts(1, false), false);
});

test('shouldSuppressFinishedToasts: exactly two simultaneous genuine finishes are surfaced, not treated as restart noise', () => {
  assert.equal(chatMod.shouldSuppressFinishedToasts(2, false), false);
});

test('shouldSuppressFinishedToasts: more than two simultaneous drops still reads as a mass restart and is suppressed', () => {
  assert.equal(chatMod.shouldSuppressFinishedToasts(3, false), true);
  assert.equal(chatMod.shouldSuppressFinishedToasts(10, false), true);
});

test('shouldSuppressFinishedToasts: a just-reconnected poll suppresses regardless of the drop count (unknown-length gap, can\'t trust the diff)', () => {
  assert.equal(chatMod.shouldSuppressFinishedToasts(1, true), true);
  assert.equal(chatMod.shouldSuppressFinishedToasts(2, true), true);
});
