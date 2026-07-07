import { test } from 'node:test';
import assert from 'node:assert';
import { editPendingOnMobile, cancelMobileEdit } from '../redesign/mobile/edit-flow.js';

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
        pendingSend: pendingId ? { messageId: pendingId, text: pendingText, timerId } : null,
      },
    },
  };
}

test('editPendingOnMobile clears timer, removes optimistic bubble, copies text into draft', () => {
  const cleared = [];
  const state = makeState();
  editPendingOnMobile(state, 'u1', { clearTimeout: (id) => cleared.push(id) });
  assert.deepStrictEqual(cleared, [999]);
  assert.strictEqual(state.live.chat.thread.length, 0);
  assert.strictEqual(state.draft, 'hello there');
  assert.deepStrictEqual(state.mobileEditingPending, { originalMsgId: 'u1' });
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

test('cancelMobileEdit clears draft, editing state, focus', () => {
  const state = { draft: 'partial edit', focus: 'mdraft', mobileEditingPending: { originalMsgId: 'u1' } };
  cancelMobileEdit(state);
  assert.strictEqual(state.draft, '');
  assert.strictEqual(state.mobileEditingPending, null);
  assert.strictEqual(state.focus, null);
});

test('cancelMobileEdit is safe when nothing to cancel', () => {
  const state = { draft: '', focus: null, mobileEditingPending: null };
  cancelMobileEdit(state);
  assert.strictEqual(state.mobileEditingPending, null);
});
