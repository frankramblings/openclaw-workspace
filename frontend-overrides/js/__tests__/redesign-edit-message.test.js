// Tests for Task 8's inline message editor: editMessage/saveEdit/cancelEdit
// (the Save & Send flow that mutates a still-buffered optimistic bubble) plus
// clearBranchPrefixIfStarted (branch-prefix cleanup once a branched session
// actually has a real message in its thread).
//
// live/chat.js is a browser module (fetch/location/DOM), so this test stubs
// the minimum browser surface it touches — same shim set as
// redesign-send-buffer.test.js / redesign-branch-from-message.test.js. The
// toast() helper isn't exported, so its DOM writes are captured through a
// fake `.oc-toast-msg` element whose `textContent` setter records the text.
import { test, mock } from 'node:test';
import assert from 'node:assert';

// ---- minimal browser shims (must exist before chat.js's transitive imports
// evaluate — api.js reads `location.origin` at module-load time) ------------
globalThis.location = { origin: 'http://localhost' };
const storageBacking = new Map();
globalThis.localStorage = {
  getItem: (k) => (storageBacking.has(k) ? storageBacking.get(k) : null),
  setItem: (k, v) => { storageBacking.set(k, String(v)); },
  removeItem: (k) => { storageBacking.delete(k); },
};
globalThis.window = globalThis;

const toastMessages = [];
let toastHost = null;
function makeFakeEl() {
  return {
    className: '',
    id: '',
    style: {},
    classList: { add() {}, remove() {} },
    appendChild() {},
    querySelector(sel) {
      if (sel === '.oc-toast-msg') {
        // toast() does `el.querySelector('.oc-toast-msg').textContent = text`
        // — a setter-only stand-in is enough to observe what it wrote.
        return { set textContent(v) { toastMessages.push(v); } };
      }
      return null;
    },
    addEventListener() {},
    remove() {},
  };
}
globalThis.document = {
  querySelector: () => null,
  getElementById: (id) => (id === 'oc-toast-host' ? toastHost : null),
  createElement: () => makeFakeEl(),
  body: { appendChild: (child) => { toastHost = child; } },
};
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions, clearBranchPrefixIfStarted } = await import('../redesign/live/chat.js');

function freshState() {
  return {
    draft: '',
    editDraft: null,
    live: {
      chat: {
        activeId: 'sess-1',
        model: 'test-model',
        thread: [
          { id: 'u1', role: 'user', text: 'old', time: '09:00', _optimistic: true, _deadline: Date.now() + 700 },
        ],
        pendingSend: { messageId: 'u1', text: 'old', attachSnap: [], sessionId: 'sess-1', deadline: Date.now() + 700, timerId: 0 },
      },
    },
  };
}

// ---- saveEdit within the buffer window -------------------------------------

test('saveEdit within the buffer window updates pendingSend + the optimistic message and flushes', async () => {
  toastMessages.length = 0;
  const state = freshState();
  runtime.state = state;
  runtime.render = mock.fn(() => {});
  const fetchCalls = [];
  globalThis.fetch = mock.fn(async (url, opts) => { fetchCalls.push({ url, opts }); return { ok: true, body: null }; });

  try {
    const chat = state.live.chat;

    actions.editMessage('u1');
    assert.strictEqual(chat.editingId, 'u1', 'editMessage should open the inline editor for this message');
    assert.strictEqual(state.editDraft, 'old', 'editDraft should seed from the buffered pendingSend text');

    state.editDraft = 'new';
    actions.saveEdit('u1');

    assert.strictEqual(chat.editingId, null, 'saveEdit closes the inline editor');
    assert.strictEqual(chat.pendingSend, null, 'saveEdit flushes — pendingSend is cleared');
    const msg = chat.thread.find((m) => m.id === 'u1');
    assert.strictEqual(msg.text, 'new', 'the optimistic message model must carry the edited text');
    assert.strictEqual(msg._optimistic, undefined, 'flush clears the optimistic flag');

    // flushPending -> fireSend -> postStream should have fired the real POST
    // with the edited text, proving flushPending actually ran.
    assert.strictEqual(fetchCalls.length, 1, 'saveEdit should trigger exactly one flush POST');
    assert.strictEqual(fetchCalls[0].opts.body.get('message'), 'new', 'the flushed POST must carry the edited text');
  } finally {
    delete globalThis.fetch;
  }
});

// ---- saveEdit race: the buffer already flushed on its own timer ------------

test('saveEdit after the buffer already flushed toasts "too late" and does not crash', () => {
  toastMessages.length = 0;
  const state = freshState();
  const chat = state.live.chat;
  chat.pendingSend = null; // already flushed by its own timer
  chat.editingId = 'u1';
  state.editDraft = 'new text';
  runtime.state = state;
  runtime.render = mock.fn(() => {});

  assert.doesNotThrow(() => actions.saveEdit('u1'));

  assert.strictEqual(chat.editingId, null, 'the editor still closes even though the flush already happened');
  assert.strictEqual(state.editDraft, null);
  assert.ok(
    toastMessages.some((m) => /too late/i.test(m)),
    `expected a "too late" toast, got: ${JSON.stringify(toastMessages)}`,
  );
});

// ---- cancelEdit -------------------------------------------------------------

test('cancelEdit clears editingId and editDraft without touching pendingSend', () => {
  const state = freshState();
  const chat = state.live.chat;
  runtime.state = state;
  runtime.render = mock.fn(() => {});

  actions.editMessage('u1');
  assert.strictEqual(chat.editingId, 'u1');
  assert.strictEqual(state.editDraft, 'old');

  actions.cancelEdit('u1');

  assert.strictEqual(chat.editingId, null, 'cancelEdit clears editingId');
  assert.strictEqual(state.editDraft, null, 'cancelEdit clears editDraft');
  // The original buffered send is untouched — cancel doesn't flush or drop it.
  assert.ok(chat.pendingSend, 'pendingSend should survive a cancel');
  assert.strictEqual(chat.pendingSend.text, 'old');
});

// ---- clearBranchPrefixIfStarted --------------------------------------------

test('clearBranchPrefixIfStarted clears state + localStorage once the thread has a real message', () => {
  storageBacking.clear();
  const state = { branchPrefix: [{ role: 'user', text: 'x' }] };
  const chat = { activeId: 'sess1', thread: [{ id: 'u1', role: 'user', text: 'hi' }] };
  storageBacking.set('branchPrefix:sess1', JSON.stringify(state.branchPrefix));

  clearBranchPrefixIfStarted(state, chat);

  assert.strictEqual(state.branchPrefix, null);
  assert.strictEqual(globalThis.localStorage.getItem('branchPrefix:sess1'), null);
});

test('clearBranchPrefixIfStarted leaves state + localStorage untouched when the thread is still empty', () => {
  storageBacking.clear();
  const prefix = [{ role: 'user', text: 'x' }];
  const state = { branchPrefix: prefix };
  const chat = { activeId: 'sess1', thread: [] };
  storageBacking.set('branchPrefix:sess1', JSON.stringify(prefix));

  clearBranchPrefixIfStarted(state, chat);

  assert.strictEqual(state.branchPrefix, prefix, 'branchPrefix must survive while the branched thread is still empty');
  assert.strictEqual(globalThis.localStorage.getItem('branchPrefix:sess1'), JSON.stringify(prefix));
});
