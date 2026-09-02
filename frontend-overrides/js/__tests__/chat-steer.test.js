// Steering while a turn runs. Mirrors the shims in chat-turn-epoch.test.js.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { constructor(u) { this.url = String(u); this.readyState = 1; } close() { this.readyState = 2; } };
globalThis.EventSource.CLOSED = 2;

const { runtime } = await import('../redesign/live/runtime.js');
const chatMod = await import('../redesign/live/chat.js');
const { actions, flushPending } = chatMod;

const jsonRes = (status, obj) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => 'application/json' },
  json: async () => obj, text: async () => JSON.stringify(obj),
});

function freshState(activeId = 'sess-1') {
  return {
    draft: '', pendingAttach: [], surface: 'chat',
    caps: { steer: { available: true } },
    live: { chat: { activeId, model: 'test-model', endpointId: 'claude-cli', thread: [] } },
  };
}

// fetch mock: chat_stream hangs (a live turn), /api/chat/steer answers per `steerRes`.
function wireFetch(calls, steerRes) {
  globalThis.fetch = (url, opts) => {
    const u = String(url);
    calls.push({ url: u, opts });
    if (u.includes('/api/chat_stream')) return new Promise(() => {});
    if (u.includes('/api/chat/steer/')) return Promise.resolve(steerRes);
    return Promise.resolve(jsonRes(200, {}));
  };
}

const tick = async (ms = 750) => { await new Promise((r) => setTimeout(r, ms)); await Promise.resolve(); };

async function startLiveTurn(state, calls) {
  state.draft = 'first question';
  await actions.send();
  await tick();                       // buffer elapses → POST /api/chat_stream (hangs)
  assert.ok(calls.some((c) => c.url.includes('/api/chat_stream')), 'turn started');
}

test('busy thread + steer available → POST /api/chat/steer, bubble marked steer, no queue', async () => {
  const state = freshState();
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true, steered: true, runId: 'r1' }));
  await startLiveTurn(state, calls);

  state.draft = 'prefer the smaller patch';
  await actions.send();
  await tick();
  const steerCall = calls.find((c) => c.url.includes('/api/chat/steer/sess-1'));
  assert.ok(steerCall, 'steer POST fired');
  const fd = steerCall.opts.body;
  assert.equal(fd.get('message'), 'prefer the smaller patch');
  assert.ok(String(fd.get('client_id')).startsWith('live-u-'));
  const users = state.live.chat.thread.filter((m) => m.role === 'user');
  assert.equal(users.length, 2);
  assert.equal(users[1].steer, true);
  assert.equal((state.live.chat.queuedList || []).length, 0);
  actions.stopRun && await actions.stopRun();
});

test('steer 409 no_active_turn → falls back to a normal send', async () => {
  const state = freshState('sess-2');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(409, { ok: false, reason: 'no_active_turn' }));
  await startLiveTurn(state, calls);
  const before = calls.filter((c) => c.url.includes('/api/chat_stream')).length;

  state.draft = 'second';
  await actions.send();
  await tick();
  const after = calls.filter((c) => c.url.includes('/api/chat_stream')).length;
  assert.equal(after, before + 1, 'a normal turn was posted');
  assert.equal((state.live.chat.queuedList || []).length, 0);
  actions.stopRun && await actions.stopRun();
});

test('steer 409 steer_unavailable → queued, steer bubble removed', async () => {
  const state = freshState('sess-3');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(409, { ok: false, reason: 'steer_unavailable' }));
  await startLiveTurn(state, calls);

  state.draft = 'later please';
  await actions.send();
  await tick();
  assert.equal(state.live.chat.queuedList.length, 1);
  assert.equal(state.live.chat.queuedList[0].text, 'later please');
  assert.ok(!state.live.chat.thread.some((m) => m.steer), 'optimistic steer bubble withdrawn');
  actions.stopRun && await actions.stopRun();
});

test('capability missing → queue without calling /api/chat/steer', async () => {
  const state = freshState('sess-4');
  state.caps = { steer: { available: false } };
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true }));
  await startLiveTurn(state, calls);
  state.draft = 'q';
  await actions.send();
  await tick();
  assert.ok(!calls.some((c) => c.url.includes('/api/chat/steer/')));
  assert.equal(state.live.chat.queuedList.length, 1);
  actions.stopRun && await actions.stopRun();
});

test('sendQueued always queues even when steer is available', async () => {
  const state = freshState('sess-5');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true }));
  await startLiveTurn(state, calls);
  state.draft = 'after this';
  await actions.sendQueued();
  await tick();
  assert.ok(!calls.some((c) => c.url.includes('/api/chat/steer/')));
  assert.equal(state.live.chat.queuedList.length, 1);
  actions.stopRun && await actions.stopRun();
});

test('user_steer frame replay: inserts the bubble once and opens a fresh assistant bubble', async () => {
  const state = freshState('sess-6');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true }));
  await startLiveTurn(state, calls);
  const origRAF = globalThis.requestAnimationFrame;
  // The file-level rAF stub (`() => 1`) never invokes its callback, so the
  // typewriter pump that drains `turn.pending` into the bubble's `.text`
  // never runs — same gap chat-turn-epoch.test.js's streaming-bubble test
  // hits, fixed there with this exact microtask-deferred override (a
  // synchronous callback would re-enter and corrupt turn.pumpRAF — see that
  // file's comment). Scoped to this test only; restored in `finally`.
  globalThis.requestAnimationFrame = (fn) => { queueMicrotask(fn); return 1; };
  const drainMicrotasks = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setImmediate(r));
  };
  try {
    const on = chatMod.__testOnEvent();       // exported test hook → current turn's onEvent
    on({ delta: 'Working on it. ' });
    on({ type: 'user_steer', text: 'use 42', client_id: 'live-u-x1', ts: 1 });
    on({ type: 'user_steer', text: 'use 42', client_id: 'live-u-x1', ts: 1 });   // duplicate
    on({ delta: 'Using 42.' });
    await drainMicrotasks();
    const t = state.live.chat.thread;
    const roles = t.map((m) => m.role);
    assert.deepEqual(roles.slice(-3), ['assistant', 'user', 'assistant']);
    assert.equal(t.filter((m) => m.id === 'live-u-x1').length, 1);
    assert.equal(t[t.length - 1].text.includes('Using 42.'), true);
    assert.equal(t[t.length - 3].streaming, false);
  } finally {
    globalThis.requestAnimationFrame = origRAF;
  }
  actions.stopRun && await actions.stopRun();
});

test('sendQueued on an empty draft does not leave _forceQueue set for the next send', async () => {
  const state = freshState('sess-7');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true, steered: true, runId: 'r1' }));
  await startLiveTurn(state, calls);

  // Alt+Enter (sendQueued) on an empty composer: nothing to send, and the
  // forceQueue flag it sets must not survive the early return inside send().
  state.draft = '';
  await actions.sendQueued();
  await tick();
  assert.ok(!calls.some((c) => c.url.includes('/api/chat/steer/')));
  assert.equal((state.live.chat.queuedList || []).length, 0);

  // A real send right after must steer normally — proof the flag didn't leak.
  state.draft = 'now for real';
  await actions.send();
  await tick();
  const steerCall = calls.find((c) => c.url.includes('/api/chat/steer/sess-7'));
  assert.ok(steerCall, 'steer POST fired on the send after the empty sendQueued');
  assert.equal((state.live.chat.queuedList || []).length, 0);
  actions.stopRun && await actions.stopRun();
});

test('turn ends inside the buffer window → the steer caption is dropped and a normal send fires', async () => {
  const state = freshState('sess-8');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true, steered: true, runId: 'r1' }));
  await startLiveTurn(state, calls);
  const before = calls.filter((c) => c.url.includes('/api/chat_stream')).length;

  // Composer submit takes the steer path (turn is live) and arms the 700ms
  // buffer — but the turn finishes BEFORE the buffer elapses, so flushPending
  // falls through to the ordinary send path and starts a brand-new turn.
  state.draft = 'actually use 42';
  await actions.send();
  chatMod.__testOnEvent()({ type: 'done' });
  await tick();

  assert.ok(!calls.some((c) => c.url.includes('/api/chat/steer/')), 'no steer POST');
  const after = calls.filter((c) => c.url.includes('/api/chat_stream')).length;
  assert.equal(after, before + 1, 'a normal turn was posted instead');
  const users = state.live.chat.thread.filter((m) => m.role === 'user');
  const last = users[users.length - 1];
  assert.equal(last.text, 'actually use 42');
  assert.equal(last.steer, undefined, 'no "Steered into the running turn" caption');
  assert.equal(last.steerNotice, undefined);
  actions.stopRun && await actions.stopRun();
});

test('user_steer replay after a reload reuses the history bubble instead of duplicating it', async () => {
  const state = freshState('sess-9');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true }));
  await startLiveTurn(state, calls);

  // Simulate the reload shape: history (h*) already carries the steer, because
  // the backend persisted it the moment it landed; the replayed frame then
  // arrives with a DIFFERENT (live) client_id.
  const chat = state.live.chat;
  chat.thread = [
    { id: 'h5', role: 'user', text: 'do the thing' },
    { id: 'h6', role: 'assistant', text: 'Working on it.' },
    { id: 'h7', role: 'user', text: 'use 42' },
  ];
  chatMod.__testOnEvent()({ type: 'user_steer', text: 'use 42', client_id: 'live-u-zz', ts: 1 });

  const matches = chat.thread.filter((m) => m.role === 'user' && m.text === 'use 42');
  assert.equal(matches.length, 1, 'exactly one bubble for the steered text');
  assert.equal(matches[0].id, 'h7', 'the history bubble was reused, not replaced');
  assert.equal(matches[0].steer, true);
  const users = chat.thread.filter((m) => m.role === 'user');
  assert.equal(users[users.length - 1], matches[0], 'positioned last among users');
  actions.stopRun && await actions.stopRun();
});

test('done with no reply after a steer → honesty notice; a reply after the steer → none', async () => {
  const state = freshState('sess-10');
  runtime.state = state; runtime.render = () => {};
  const calls = [];
  wireFetch(calls, jsonRes(200, { ok: true }));
  await startLiveTurn(state, calls);
  let on = chatMod.__testOnEvent();
  on({ type: 'user_steer', text: 'use 42', client_id: 'live-u-a1', ts: 1 });
  on({ type: 'done' });
  let thread = state.live.chat.thread;
  const steered = thread.find((m) => m.id === 'live-u-a1');
  assert.ok(steered, 'steer bubble present');
  assert.equal(steered.steerNotice, chatMod.STEER_MISSED_NOTICE);

  // Same shape, but the model answered after the steer → nothing to warn about.
  const state2 = freshState('sess-11');
  runtime.state = state2; runtime.render = () => {};
  const calls2 = [];
  wireFetch(calls2, jsonRes(200, { ok: true }));
  await startLiveTurn(state2, calls2);
  on = chatMod.__testOnEvent();
  on({ type: 'user_steer', text: 'use 42', client_id: 'live-u-b1', ts: 1 });
  on({ delta: 'Using 42.' });
  on({ type: 'done' });
  thread = state2.live.chat.thread;
  assert.ok(!thread.some((m) => m.steerNotice), 'no notice when the reply came after the steer');
  actions.stopRun && await actions.stopRun();
});
