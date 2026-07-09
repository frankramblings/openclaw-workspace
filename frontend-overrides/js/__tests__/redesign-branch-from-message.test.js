// Tests for Task 8's branchFromMessage: the client-side prefix slice that
// gets POSTed to /api/session/branch, plus the end-to-end action (localStorage
// stash + selectSession hand-off).
//
// live/chat.js is a browser module (fetch/location/DOM), so this test stubs
// the minimum browser surface it touches — same shim set as
// redesign-send-buffer.test.js.
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
globalThis.document = { querySelector: () => null, getElementById: () => null, createElement: () => ({ classList: { add() {}, remove() {} }, appendChild() {}, querySelector: () => null, addEventListener() {} }), body: { appendChild() {} } };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions, sliceBranchPrefix } = await import('../redesign/live/chat.js');

const thread = [
  { id: 'u1', role: 'user', text: 'first question', time: '09:00' },
  { id: 'a1', role: 'assistant', text: 'first answer', time: '09:01' },
  { id: 'u2', role: 'user', text: 'second question', time: '09:02' },
  { id: 'a2', role: 'assistant', text: 'second answer', time: '09:03' },
];

// ---- pure slicing logic ----------------------------------------------------

test('slices the prefix through and including the target message', () => {
  const prefix = sliceBranchPrefix(thread, 'a1');
  assert.deepStrictEqual(prefix, [
    { id: 'u1', role: 'user', text: 'first question' },
    { id: 'a1', role: 'assistant', text: 'first answer' },
  ]);
});

test('branching from the very first message returns a one-item prefix', () => {
  const prefix = sliceBranchPrefix(thread, 'u1');
  assert.deepStrictEqual(prefix, [{ id: 'u1', role: 'user', text: 'first question' }]);
});

test('branching from the last message returns the whole thread', () => {
  const prefix = sliceBranchPrefix(thread, 'a2');
  assert.strictEqual(prefix.length, 4);
  assert.strictEqual(prefix[3].id, 'a2');
});

test('returns null when the message id is not found', () => {
  assert.strictEqual(sliceBranchPrefix(thread, 'does-not-exist'), null);
});

test('tolerates a missing/empty thread', () => {
  assert.strictEqual(sliceBranchPrefix(undefined, 'u1'), null);
  assert.strictEqual(sliceBranchPrefix([], 'u1'), null);
});

test('drops extra message fields — only id/role/text cross the wire', () => {
  const withExtra = [{ id: 'u1', role: 'user', text: 'hi', time: '09:00', _optimistic: true }];
  const prefix = sliceBranchPrefix(withExtra, 'u1');
  assert.deepStrictEqual(prefix, [{ id: 'u1', role: 'user', text: 'hi' }]);
});

// ---- branchFromMessage action (network + localStorage + hand-off) ---------

function freshState() {
  return {
    draft: '',
    live: { chat: { activeId: 'sess-1', model: 'test-model', thread: thread.map((m) => ({ ...m })) } },
  };
}

test("branchFromMessage toasts and never fetches when the message id isn't found", async () => {
  runtime.state = freshState();
  runtime.render = () => {};
  let fetchCalled = false;
  globalThis.fetch = mock.fn(async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; });
  try {
    await actions.branchFromMessage('nope');
    assert.strictEqual(fetchCalled, false);
  } finally {
    delete globalThis.fetch;
  }
});

test('branchFromMessage POSTs the sliced prefix and stashes the response for selectSession to pick up', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  let posted = null;
  globalThis.fetch = mock.fn(async (url, opts) => {
    if (url === '/api/session/branch') {
      posted = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ session_id: 'sess-2', session_key: 'key-2', prefix: posted.prefix }) };
    }
    // selectSession's own follow-up fetches (sessions list, history, usage) —
    // fail soft, selectSession swallows these in try/catch.
    throw new Error(`unexpected fetch: ${url}`);
  });
  const origSelect = actions.selectSession;
  const selectedIds = [];
  actions.selectSession = async (id) => { selectedIds.push(id); };
  try {
    await actions.branchFromMessage('a1');
    assert.deepStrictEqual(posted, {
      source_session_id: 'sess-1',
      prefix: [
        { id: 'u1', role: 'user', text: 'first question' },
        { id: 'a1', role: 'assistant', text: 'first answer' },
      ],
    });
    assert.deepStrictEqual(selectedIds, ['sess-2']);
    assert.strictEqual(
      globalThis.localStorage.getItem('branchPrefix:sess-2'),
      JSON.stringify(posted.prefix),
    );
  } finally {
    actions.selectSession = origSelect;
    delete globalThis.fetch;
  }
});

test('branchFromMessage surfaces the backend error body on a non-2xx response', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  globalThis.fetch = mock.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: 'source session not found' }) }));
  const origSelect = actions.selectSession;
  let selectCalled = false;
  actions.selectSession = async () => { selectCalled = true; };
  try {
    await actions.branchFromMessage('a1');
    assert.strictEqual(selectCalled, false, 'a failed branch must not switch sessions');
  } finally {
    actions.selectSession = origSelect;
    delete globalThis.fetch;
  }
});
