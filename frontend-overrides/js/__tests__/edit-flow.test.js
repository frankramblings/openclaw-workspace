// Task 3.5: mobile edit-Cancel must not discard the message.
//
// Bug: editPendingOnMobile splices the optimistic bubble OUT of the thread
// and kills the send timer to let the user revise the text. Previously,
// cancelMobileEdit just wiped the draft — a message the user watched
// "send" was silently destroyed. These tests pin the fix: Cancel restores
// the bubble to its original spot, re-arms a fresh send timer (desktop
// parity — the message still sends after the grace window), and restores
// whatever draft the user had typed before they tapped Edit.
import { test } from 'node:test';
import assert from 'node:assert';
import { editPendingOnMobile, cancelMobileEdit, commitMobileEditIfPending } from '../redesign/mobile/edit-flow.js';

function makeState({ pendingId = 'u1', pendingText = 'hello there', timerId = 999, thread = null, draft = '' } = {}) {
  const t = thread || [
    { id: 'u0', role: 'assistant', text: 'hi' },
    { id: 'u1', role: 'user', text: 'hello there', _optimistic: true, _deadline: Date.now() + 700 },
  ];
  return {
    draft,
    focus: null,
    mobileEditingPending: null,
    live: {
      chat: {
        activeId: 'sess-1',
        thread: t,
        pendingSend: pendingId ? { messageId: pendingId, text: pendingText, timerId, attachSnap: [], sessionId: 'sess-1' } : null,
      },
    },
  };
}

test('edit then cancel: bubble restored at its original index', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  assert.strictEqual(state.live.chat.thread.length, 1, 'bubble spliced out while editing');

  cancelMobileEdit(state, { setTimeout: () => 1 });

  assert.strictEqual(state.live.chat.thread.length, 2);
  assert.strictEqual(state.live.chat.thread[1].id, 'u1');
  assert.strictEqual(state.live.chat.thread[1].text, 'hello there');
  assert.strictEqual(state.live.chat.thread[0].id, 'u0');
});

test('edit then cancel: restores the bubble at a middle index, not just appended', () => {
  const thread = [
    { id: 'a', role: 'user', text: 'first' },
    { id: 'u1', role: 'user', text: 'hello there', _optimistic: true, _deadline: Date.now() + 700 },
    // Note: in practice a pendingSend bubble is always the newest message, so
    // there's nothing after it — but the restore must still respect whatever
    // index it was spliced from, not just push().
  ];
  const state = makeState({ thread });
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  cancelMobileEdit(state, { setTimeout: () => 1 });
  assert.strictEqual(state.live.chat.thread.map((m) => m.id).join(','), 'a,u1');
});

test('edit then cancel: send timer is re-armed via the injected setTimeout', () => {
  const state = makeState({ timerId: 999 });
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });

  const calls = [];
  cancelMobileEdit(state, {
    setTimeout: (fn, ms) => { calls.push({ fn, ms }); return 4242; },
  });

  assert.strictEqual(calls.length, 1, 'cancel must arm exactly one new timer');
  assert.strictEqual(typeof calls[0].ms, 'number');
  assert.ok(calls[0].ms > 0, 'grace window must be a positive delay');
  assert.strictEqual(typeof calls[0].fn, 'function', 'must pass a callback, not just query a delay');

  // chat.pendingSend must be restored with the new timerId so a real flush
  // path (keyed off pendingSend) would find it live again.
  const p = state.live.chat.pendingSend;
  assert.ok(p, 'pendingSend must be restored');
  assert.strictEqual(p.messageId, 'u1');
  assert.strictEqual(p.text, 'hello there');
  assert.strictEqual(p.sessionId, 'sess-1');
  assert.strictEqual(p.timerId, 4242);
});

test('edit then cancel: the re-armed timer, once it fires, drives a flush call (message still sends)', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });

  let firedFn = null;
  const flushed = [];
  cancelMobileEdit(state, {
    setTimeout: (fn) => { firedFn = fn; return 1; },
    flush: (sessionId) => flushed.push(sessionId),
  });

  assert.strictEqual(typeof firedFn, 'function');
  firedFn(); // simulate the grace window elapsing
  assert.deepStrictEqual(flushed, ['sess-1']);
});

test('edit then cancel: restores whatever draft the user had before tapping Edit', () => {
  const state = makeState({ draft: 'unrelated in-progress draft' });
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  // editing moves the pending message's text into the draft box
  assert.strictEqual(state.draft, 'hello there');

  cancelMobileEdit(state, { setTimeout: () => 1 });
  assert.strictEqual(state.draft, 'unrelated in-progress draft');
});

test('edit then cancel: clears editing state and focus, same as before', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  cancelMobileEdit(state, { setTimeout: () => 1 });
  assert.strictEqual(state.mobileEditingPending, null);
  assert.strictEqual(state.focus, null);
});

test('cancelMobileEdit is still a safe no-op when nothing is being edited', () => {
  const state = { draft: '', focus: null, mobileEditingPending: null };
  cancelMobileEdit(state);
  assert.strictEqual(state.mobileEditingPending, null);
  assert.strictEqual(state.draft, '');
  assert.strictEqual(state.focus, null);
});

test('cancelMobileEdit tolerates a missing io argument (production call site passes none today)', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  assert.doesNotThrow(() => cancelMobileEdit(state));
  assert.strictEqual(state.live.chat.thread.length, 2);
});

// ---- cross-session Cancel (3.5 review): the user switched threads mid-edit --

test('cross-session cancel routes the message to its own session queue via io.queue, never the viewed thread', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  // Mid-edit the user opens another conversation: chat.thread now belongs to
  // sess-2, so splicing the restored bubble in would misfile it there.
  state.live.chat.activeId = 'sess-2';
  state.live.chat.thread = [{ id: 'c1', role: 'assistant', text: 'other thread' }];

  const queued = [];
  const timers = [];
  cancelMobileEdit(state, {
    setTimeout: (fn, ms) => { timers.push(ms); return 1; },
    queue: (sid, text, attachSnap) => queued.push({ sid, text, attachSnap }),
  });

  assert.deepStrictEqual(queued, [{ sid: 'sess-1', text: 'hello there', attachSnap: [] }],
    'message routed to ITS OWN session\'s queue');
  assert.deepStrictEqual(state.live.chat.thread.map((m) => m.id), ['c1'],
    'no bubble misfiled into the viewed thread');
  assert.strictEqual(timers.length, 0, 'no send timer armed against the wrong view');
  assert.strictEqual(state.live.chat.pendingSend, null, 'no pendingSend re-armed for the wrong view');
  assert.strictEqual(state.mobileEditingPending, null);
  assert.strictEqual(state.focus, null);
});

test('cross-session cancel without io.queue still queues directly, never splices', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  state.live.chat.activeId = 'sess-2';

  cancelMobileEdit(state, { setTimeout: () => 1 });

  assert.deepStrictEqual(state.live.chat.queuedList,
    [{ sid: 'sess-1', text: 'hello there', attachSnap: [] }]);
  assert.strictEqual(state.live.chat.thread.length, 1,
    'thread untouched (only u0 remains — u1 was spliced out by the edit)');
  assert.strictEqual(state.live.chat.pendingSend, null);
});

test('same-session cancel still restores the bubble + re-arms the send (queue path not taken)', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });

  const queued = [];
  cancelMobileEdit(state, { setTimeout: () => 7, queue: (...a) => queued.push(a) });

  assert.deepStrictEqual(queued, [], 'matching sessions never route to the queue');
  assert.strictEqual(state.live.chat.thread.length, 2, 'bubble restored');
  assert.ok(state.live.chat.pendingSend, 'send re-armed');
});

// ---- double-fired Cancel guard (3.5 review, minor) ---------------------------

test('double-fired Cancel is inert: the second call cannot wipe the just-restored draft', () => {
  const state = makeState({ draft: 'prior draft' });
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  cancelMobileEdit(state, { setTimeout: () => 1 });
  assert.strictEqual(state.draft, 'prior draft');

  state.draft = 'typed after cancel';
  const threadBefore = state.live.chat.thread.map((m) => m.id).join(',');
  cancelMobileEdit(state, { setTimeout: () => 1 });

  assert.strictEqual(state.draft, 'typed after cancel', 'second Cancel must not wipe the draft');
  assert.strictEqual(state.live.chat.thread.map((m) => m.id).join(','), threadBefore,
    'no double restore');
});

test('commit-edit path is unchanged: commitMobileEditIfPending just clears the editing flag', () => {
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  assert.notStrictEqual(state.mobileEditingPending, null);
  commitMobileEditIfPending(state);
  assert.strictEqual(state.mobileEditingPending, null);
  // Commit does not touch the thread or draft itself — that's the send
  // action's job (app.js), which fires before commitMobileEditIfPending runs.
  assert.strictEqual(state.live.chat.thread.length, 1);
});

test('commitMobileEditIfPending is a no-op when nothing is pending', () => {
  const state = { mobileEditingPending: null };
  commitMobileEditIfPending(state);
  assert.strictEqual(state.mobileEditingPending, null);
});
