// Pillar C2: does live/chat.js attach active_doc_id/active_doc_selection to a
// send, and does it route an incoming doc_update frame into the document
// editor? Mirrors the shims and __testOnEvent() pattern in chat-steer.test.js.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { runtime } = await import('../redesign/live/runtime.js');
const chatMod = await import('../redesign/live/chat.js');
const { actions } = chatMod;

function freshState(activeId, docEditor) {
  const state = {
    draft: '', pendingAttach: [], surface: 'chat',
    caps: { steer: { available: false } },
    live: { chat: { activeId, model: 'test-model', endpointId: 'claude-cli', thread: [] } },
  };
  if (docEditor) state.docEditor = docEditor;
  return state;
}

function baseDocEditor(overrides) {
  return Object.assign({
    open: true, id: 'doc-9', title: 'Spec', status: 'Saved',
    wsPath: null, wsRootKey: null, wsMtimeNs: null, wsAbsPath: null,
    readOnly: false, loadFailed: false, saveFailed: false, attachDetached: false,
  }, overrides);
}

function wireHangingFetch(calls) {
  globalThis.fetch = (url, opts) => { calls.push({ url: String(url), opts }); return new Promise(() => {}); };
}

const tick = async (ms = 750) => { await new Promise((r) => setTimeout(r, ms)); await Promise.resolve(); };

async function sendAndGetCall(state, calls) {
  runtime.state = state; runtime.render = () => {};
  wireHangingFetch(calls);
  state.draft = 'go';
  await actions.send();
  await tick();
  return calls.find((c) => c.url.includes('/api/chat_stream'));
}

test('a send with a Library doc open attaches active_doc_id', async () => {
  const calls = [];
  const call = await sendAndGetCall(freshState('sess-doc-1', baseDocEditor()), calls);
  assert.ok(call, 'chat_stream POST fired');
  assert.equal(call.opts.body.get('active_doc_id'), 'doc-9');
  assert.equal(call.opts.body.get('active_doc_selection'), null); // no editor instance in this harness
  actions.stopRun && await actions.stopRun();
});

test('a send omits active_doc_id with nothing open, a workspace file, or a detached pill', async () => {
  for (const docEditor of [undefined,
    baseDocEditor({ id: null, wsPath: 'notes/a.md', wsRootKey: 'workspace' }),
    baseDocEditor({ attachDetached: true })]) {
    const calls = [];
    const call = await sendAndGetCall(freshState(`sess-${Math.random()}`, docEditor), calls);
    assert.ok(call);
    assert.equal(call.opts.body.get('active_doc_id'), null);
    actions.stopRun && await actions.stopRun();
  }
});

test('a detached pill omits active_doc_id for exactly one send, then re-attaches on its own', async () => {
  const state = freshState('sess-doc-7', baseDocEditor({ attachDetached: true }));
  const call1 = await sendAndGetCall(state, []);
  assert.equal(call1.opts.body.get('active_doc_id'), null, 'first send: still detached');
  assert.equal(state.docEditor.attachDetached, false, 'consumeAttachDetach cleared it after that send');
  actions.stopRun && await actions.stopRun();

  const call2 = await sendAndGetCall(state, []);
  assert.equal(call2.opts.body.get('active_doc_id'), 'doc-9', 'second send: re-attached automatically');
  actions.stopRun && await actions.stopRun();
});

test('doc_update frame for the open Library doc updates its title/status in place', async () => {
  const state = freshState('sess-doc-5', baseDocEditor({ id: 'doc-1', title: 'Old' }));
  await sendAndGetCall(state, []);
  chatMod.__testOnEvent()({ type: 'doc_update', doc_id: 'doc-1', content: 'New body', version: 2, title: 'New Title', language: 'markdown' });
  assert.equal(state.docEditor.title, 'New Title');
  assert.equal(state.docEditor.status, 'Saved');
  actions.stopRun && await actions.stopRun();
});

test('doc_update frame for a different doc id is ignored', async () => {
  const state = freshState('sess-doc-6', baseDocEditor({ id: 'doc-1', title: 'Old' }));
  await sendAndGetCall(state, []);
  chatMod.__testOnEvent()({ type: 'doc_update', doc_id: 'doc-999', content: 'x', version: 2, title: 'Nope' });
  assert.equal(state.docEditor.title, 'Old');
  actions.stopRun && await actions.stopRun();
});
