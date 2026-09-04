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
const { actions, trimSelectionText, selectionField } = chatMod;

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

// ---- selection trimming (Fix round 1) --------------------------------------

const byteLen = (s) => new TextEncoder().encode(s).length;

// True if `s` contains any UTF-16 code unit that is a surrogate half with no
// matching partner (a high surrogate not followed by a low one, or a low
// surrogate not preceded by a high one): the signature of a naive substring
// cut landing inside what was originally one surrogate pair.
function hasLoneSurrogate(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++; // matched pair, skip the low half
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true; // low surrogate with no preceding high surrogate
    }
  }
  return false;
}

test('trimSelectionText passes an under-cap selection through unchanged', () => {
  const out = trimSelectionText(3, 9, 'hello!');
  assert.deepEqual(out, { from: 3, to: 9, text: 'hello!' });
});

test('trimSelectionText trims a 20 KB ASCII selection under the 8 KB wire cap and clamps `to`', () => {
  const text = 'a'.repeat(20 * 1024);
  const out = trimSelectionText(100, 100 + text.length, text);
  const wireBytes = byteLen(JSON.stringify(out));
  assert.ok(wireBytes < 8192, `field is ${wireBytes} bytes`);
  assert.equal(out.from, 100, '`from` kept as given');
  assert.equal(out.to, out.from + out.text.length, '`to` clamped to from + the shipped text length');
  assert.ok(!hasLoneSurrogate(out.text), 'no lone surrogate in the shipped text');
});

test('trimSelectionText trims a 9000-emoji selection under the 8 KB wire cap and clamps `to`', () => {
  const text = '😀'.repeat(9000); // each emoji is a surrogate pair: 2 UTF-16 units, 4 UTF-8 bytes
  const out = trimSelectionText(0, text.length, text);
  const wireBytes = byteLen(JSON.stringify(out));
  assert.ok(wireBytes < 8192, `field is ${wireBytes} bytes`);
  assert.equal(out.from, 0);
  assert.equal(out.to, out.from + out.text.length, '`to` clamped to from + the shipped text length');
  assert.ok(!hasLoneSurrogate(out.text), 'no lone surrogate in the shipped text');
});

test('trimSelectionText trims a 9000-CJK selection under the 8 KB wire cap and clamps `to`', () => {
  const text = '中'.repeat(9000); // each CJK char: 1 UTF-16 unit, 3 UTF-8 bytes
  const out = trimSelectionText(50, 50 + text.length, text);
  const wireBytes = byteLen(JSON.stringify(out));
  assert.ok(wireBytes < 8192, `field is ${wireBytes} bytes`);
  assert.equal(out.from, 50);
  assert.equal(out.to, out.from + out.text.length, '`to` clamped to from + the shipped text length');
  assert.ok(!hasLoneSurrogate(out.text), 'no lone surrogate in the shipped text');
});

test('selectionField yields no field for a null or empty-text selection', () => {
  assert.deepEqual(selectionField('doc-1', null), {});
  assert.deepEqual(selectionField('doc-1', { from: 0, to: 0, text: '' }), {});
  assert.deepEqual(selectionField(null, { from: 0, to: 5, text: 'hi' }), {});
});
