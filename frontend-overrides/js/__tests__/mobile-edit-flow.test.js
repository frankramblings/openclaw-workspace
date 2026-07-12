import { test } from 'node:test';
import assert from 'node:assert';
import { editPendingOnMobile, cancelMobileEdit } from '../redesign/mobile/edit-flow.js';

// NOTE: as of Task 3.5 (see edit-flow.test.js) `state.mobileEditingPending`
// carries more than `{ originalMsgId }` — it also snapshots originalIndex/
// originalMsg/pending/priorDraft so cancelMobileEdit can fully restore the
// bubble + re-arm the send instead of just wiping the draft. The cases below
// keep their original intent (what editPendingOnMobile/cancelMobileEdit do
// to timer/thread/draft/focus) but assert against the richer shape.

function makeState({ pendingId = 'u1', pendingText = 'hello there', timerId = 999, thread = null } = {}) {
  const t = thread || [
    { id: 'u1', role: 'user', text: 'hello there', _optimistic: true, _deadline: Date.now() + 700 },
  ];
  return {
    draft: '',
    focus: null,
    mobileEditingPending: null,
    live: {
      chat: {
        thread: t,
        pendingSend: pendingId ? { messageId: pendingId, text: pendingText, timerId, attachSnap: [], sessionId: 'sess-1' } : null,
      },
    },
  };
}

test('editPendingOnMobile clears timer, removes optimistic bubble, copies text into draft', () => {
  const cleared = [];
  const state = makeState();
  const originalBubble = state.live.chat.thread[0];
  editPendingOnMobile(state, 'u1', { clearTimeout: (id) => cleared.push(id) });
  assert.deepStrictEqual(cleared, [999]);
  assert.strictEqual(state.live.chat.thread.length, 0);
  assert.strictEqual(state.draft, 'hello there');
  // Full snapshot shape (Task 3.5): enough to fully restore the bubble/send
  // on Cancel, not just remember which message id was being edited.
  assert.deepStrictEqual(state.mobileEditingPending, {
    originalMsgId: 'u1',
    originalIndex: 0,
    originalMsg: originalBubble,
    pending: { messageId: 'u1', text: 'hello there', attachSnap: [], sessionId: 'sess-1' },
    priorDraft: '',
  });
  assert.strictEqual(state.live.chat.pendingSend, null);
  assert.strictEqual(state.focus, 'mdraft');
});

test('editPendingOnMobile is a no-op when msgId does not match pendingSend', () => {
  const cleared = [];
  const state = makeState({ pendingId: 'u1' });
  editPendingOnMobile(state, 'u2', { clearTimeout: (id) => cleared.push(id) });
  assert.deepStrictEqual(cleared, []);
  assert.strictEqual(state.live.chat.thread.length, 1);
  assert.strictEqual(state.draft, '');
  assert.strictEqual(state.mobileEditingPending, null);
});

test('editPendingOnMobile is a no-op when pendingSend is null', () => {
  const state = makeState({ pendingId: null });
  editPendingOnMobile(state, 'u1', { clearTimeout: () => {} });
  assert.strictEqual(state.mobileEditingPending, null);
});

test('cancelMobileEdit clears editing state and focus, restores prior draft (no chat/thread present)', () => {
  // Exercises cancelMobileEdit defensively: mobileEditingPending is present
  // but state.live/chat is not (e.g. a stale snapshot) and pend.originalMsg
  // is null, so no thread splice happens — cancel must still restore the
  // draft the user had before tapping Edit (priorDraft), and always clear
  // the editing flag + focus, without throwing.
  const state = {
    draft: 'partial edit',
    focus: 'mdraft',
    mobileEditingPending: { originalMsgId: 'u1', originalIndex: 0, originalMsg: null, pending: null, priorDraft: 'unrelated draft' },
  };
  cancelMobileEdit(state);
  assert.strictEqual(state.draft, 'unrelated draft');
  assert.strictEqual(state.mobileEditingPending, null);
  assert.strictEqual(state.focus, null);
});

test('cancelMobileEdit is safe when nothing to cancel', () => {
  const state = { draft: '', focus: null, mobileEditingPending: null };
  cancelMobileEdit(state);
  assert.strictEqual(state.mobileEditingPending, null);
});
