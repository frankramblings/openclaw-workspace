// Pillar C2: the dock's AI toolbar markup (desktop row + mobile kebab menu)
// and the pure action-resolution/force-attach rules it relies on.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.document = { querySelector: () => null };
globalThis.window = { addEventListener() {}, innerWidth: 1200, toastui: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { aiToolbarHtml, aiKebabMenuHtml, resolveAiAction, consumeAttachDetach, libraryDocIdFor,
        runAiAction, askAction, dispatchAiAction, turnBusyHere,
        flushBeforeSend, flushOk, caretRestoreArgs,
        __setDirtyForTest, __setEditorForTest }
  = await import('../redesign/live/document-editor.js');
const { runtime } = await import('../redesign/live/runtime.js');
const { ASK_PLACEHOLDER } = await import('../redesign/doc-ai-prompts.js');

const ACT_NAMES = ['docAiSummarize', 'docAiRewrite', 'docAiContinue', 'docAiAsk'];

test('aiToolbarHtml: exactly the four AI actions, each a stable data-act, no em dash', () => {
  const html = aiToolbarHtml();
  for (const act of ACT_NAMES) assert.match(html, new RegExp(`data-act="${act}"`));
  assert.equal((html.match(/data-act="docAi/g) || []).length, 4);
  assert.ok(!html.includes('—'));
});

// Fix wave, I3: on the mobile shell the dock is 100vw and sits over the
// composer, so Ask would focus a textarea the user cannot see and its
// placeholder is cleared the moment the dock closes. The kebab offers the
// three one-shot edit actions only; Ask stays on the desktop toolbar.
test('aiKebabMenuHtml: the three edit actions only, no Ask, no em dash', () => {
  const html = aiKebabMenuHtml();
  for (const act of ['docAiSummarize', 'docAiRewrite', 'docAiContinue']) {
    assert.match(html, new RegExp(`data-act="${act}"`));
  }
  assert.ok(!html.includes('docAiAsk'), 'Ask cannot work behind a full-width dock');
  assert.equal((html.match(/data-act="docAi/g) || []).length, 3);
  assert.ok(!html.includes('—'));
});

test('resolveAiAction: Summarize/Continue/Rewrite dispatch to their builders; Ask sends nothing', () => {
  assert.match(resolveAiAction('docAiSummarize', null, ''), /5 to 8 bullets/);
  assert.match(resolveAiAction('docAiContinue', null, ''), /Continue writing/);
  assert.equal(resolveAiAction('docAiAsk', null, ''), null);
  assert.equal(resolveAiAction('docAiRewrite', null, 'body'), null); // nothing selected
  const md = 'line one\nline two\n';
  assert.match(resolveAiAction('docAiRewrite', { text: 'line one', from: 0, to: 8 }, md), /edit the file in place/);
});

test('force-attach rule: consumeAttachDetach re-enables attach even after the pill was detached', () => {
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: true };
  runtime.state = { docEditor: d };
  assert.equal(libraryDocIdFor(d), null, 'detached: the normal send path would omit active_doc_id');
  consumeAttachDetach();
  assert.equal(d.attachDetached, false);
  assert.equal(libraryDocIdFor(d), 'doc-1', 'the toolbar force-attach step re-enables it for this send');
});

// ---- Fix round 1 -----------------------------------------------------------

test('turnBusyHere: true only when a turn is streaming for the currently viewed session', () => {
  assert.equal(turnBusyHere({ live: { chat: { busySessionId: 's1', activeId: 's1' } } }), true);
  assert.equal(turnBusyHere({ live: { chat: { busySessionId: 's1', activeId: 's2' } } }), false, 'busy in a DIFFERENT thread is not busy HERE');
  assert.equal(turnBusyHere({ live: { chat: { busySessionId: null, activeId: 's1' } } }), false);
  assert.equal(turnBusyHere(null), false);
  assert.equal(turnBusyHere({}), false);
});

test('Important 1: runAiAction refuses while busy here, toasts, and leaves send/draft/detach untouched', () => {
  let sendCalls = 0;
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: true };
  runtime.state = {
    docEditor: d, draft: '',
    live: { chat: { busySessionId: 's1', activeId: 's1' } },
  };
  runtime.actions = { send: () => { sendCalls++; } };
  runAiAction('Summarize the open document in 5 to 8 bullets.');
  assert.equal(sendCalls, 0, 'must not fire a plain, document-blind steer into the running turn');
  assert.equal(runtime.state.draft, '', 'draft left untouched');
  assert.equal(d.attachDetached, true, 'detach flag left exactly as the user left it (not force-attached)');
  assert.match(runtime.state.inboxToast && runtime.state.inboxToast.msg, /Wait for Gary to finish before running a document action/);
});

test('Important 1: askAction is not send-gated (it never sends by itself)', () => {
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: false };
  runtime.state = {
    docEditor: d, draft: '',
    live: { chat: { busySessionId: 's1', activeId: 's1' } },
  };
  askAction();
  assert.equal(runtime.state.docAiAskPlaceholder, ASK_PLACEHOLDER, 'Ask still works while busy: it only prepares the composer, no send happens here');
});

test('Important 2: runAiAction refuses to overwrite a non-empty unsent draft', () => {
  let sendCalls = 0;
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: false };
  runtime.state = {
    docEditor: d, draft: 'a half-typed note I have not sent yet',
    live: { chat: { busySessionId: null, activeId: 's1' } },
  };
  runtime.actions = { send: () => { sendCalls++; } };
  runAiAction('Continue writing from the end of the document.');
  assert.equal(sendCalls, 0);
  assert.equal(runtime.state.draft, 'a half-typed note I have not sent yet', 'draft must not be clobbered');
  assert.equal(d.attachDetached, false, 'detach flag left untouched');
  assert.match(runtime.state.inboxToast && runtime.state.inboxToast.msg, /Send or clear your draft first/);
});

test('Important 2: runAiAction proceeds normally once the draft is empty and nothing is busy', async () => {
  let sendCalls = 0;
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: true };
  runtime.state = {
    docEditor: d, draft: '   ', // whitespace-only counts as empty
    live: { chat: { busySessionId: null, activeId: 's1' } },
  };
  runtime.actions = { send: () => { sendCalls++; } };
  await runAiAction('Continue writing from the end of the document.');
  assert.equal(sendCalls, 1);
  assert.equal(runtime.state.draft, 'Continue writing from the end of the document.');
  assert.equal(d.attachDetached, false, 'force-attach ran once the guards passed');
});

test('Important 2: askAction never touches an existing draft, only the placeholder + force-attach', () => {
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: true };
  runtime.state = { docEditor: d, draft: 'unsent note' };
  askAction();
  assert.equal(runtime.state.draft, 'unsent note', 'Ask must leave an existing draft exactly as it was');
  assert.equal(runtime.state.docAiAskPlaceholder, ASK_PLACEHOLDER);
  assert.equal(d.attachDetached, false, 'Ask still force-attaches');
});

test('Minor 3: dispatchAiAction toasts (not window.alert) when Rewrite has no selection, and sends nothing', () => {
  let sendCalls = 0;
  const d = { open: true, id: 'doc-1', wsPath: null, attachDetached: false };
  runtime.state = { docEditor: d, draft: '', inboxToast: null };
  runtime.actions = { send: () => { sendCalls++; } };
  // editor/getSelection are document-editor.js's own module-private state and
  // stay null outside a real ensureEditor() call, so getSelection() -> null
  // and resolveAiAction('docAiRewrite', null, ...) -> null, exercising the
  // exact "nothing selected" branch dispatchAiAction guards on.
  dispatchAiAction('docAiRewrite');
  assert.equal(sendCalls, 0);
  assert.match(runtime.state.inboxToast && runtime.state.inboxToast.msg, /Select some text in the document first/);
});

// ---- Fix wave: I1 (pre-send flush) and M1 (caret restore) -------------------

const docBuf = (over) => Object.assign({
  open: true, id: 'doc-1', title: 'Spec', status: '',
  wsPath: null, wsRootKey: null, wsMtimeNs: null, wsAbsPath: null,
  readOnly: false, loadFailed: false, saveFailed: false, attachDetached: false,
}, over);

test('flushBeforeSend: a clean buffer resolves skip without touching the network', async () => {
  runtime.state = { docEditor: docBuf() };
  runtime.render = () => {};
  __setDirtyForTest(false);
  __setEditorForTest({ getMarkdown: () => 'body' });
  const calls = [];
  globalThis.fetch = (url) => { calls.push(String(url)); return Promise.resolve({ ok: true }); };
  assert.equal(await flushBeforeSend(), 'skip');
  assert.deepStrictEqual(calls, [], 'a clean send pays nothing');
  __setEditorForTest(null);
});

test('flushBeforeSend: a dirty attached document is PUT before the caller proceeds', async () => {
  const d = docBuf();
  runtime.state = { docEditor: d };
  runtime.render = () => {};
  __setDirtyForTest(true);
  __setEditorForTest({ getMarkdown: () => 'the unsaved buffer' });
  const calls = [];
  globalThis.fetch = (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  };
  const status = await flushBeforeSend();
  assert.equal(status, 'ok');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/document/doc-1');
  assert.equal(calls[0].body.content, 'the unsaved buffer');
  assert.equal(d.status, 'Saved');
  __setDirtyForTest(false);
  __setEditorForTest(null);
});

test('flushBeforeSend: a dirty buffer whose document is detached still flushes nothing (no attach, no risk)', async () => {
  runtime.state = { docEditor: docBuf({ attachDetached: true }) };
  runtime.render = () => {};
  __setDirtyForTest(true);
  __setEditorForTest({ getMarkdown: () => 'x' });
  const calls = [];
  globalThis.fetch = (url) => { calls.push(String(url)); return Promise.resolve({ ok: true }); };
  assert.equal(await flushBeforeSend(), 'skip');
  assert.deepStrictEqual(calls, []);
  __setDirtyForTest(false);
  __setEditorForTest(null);
});

test('flushOk: only failed and conflict block a send', () => {
  assert.equal(flushOk('ok'), true);
  assert.equal(flushOk('skip'), true);
  assert.equal(flushOk('stale'), true);
  assert.equal(flushOk('failed'), false);
  assert.equal(flushOk('conflict'), false);
});

test('I1: a failed flush aborts the toolbar action with a toast, and sends nothing', async () => {
  let sendCalls = 0;
  const d = docBuf({ attachDetached: false });
  runtime.state = { docEditor: d, draft: '', inboxToast: null, live: { chat: {} } };
  runtime.render = () => {};
  runtime.actions = Object.assign({}, runtime.actions, { send: () => { sendCalls++; } });
  __setDirtyForTest(true);
  __setEditorForTest({ getMarkdown: () => 'unsaved' });
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 500 });
  await runAiAction('Continue writing from the end of the document.');
  assert.equal(sendCalls, 0, 'a stale attach must never reach the backend');
  assert.equal(runtime.state.draft, '', 'the action never claimed the composer');
  assert.match(runtime.state.inboxToast && runtime.state.inboxToast.msg, /Could not save the document/);
  __setDirtyForTest(false);
  __setEditorForTest(null);
});

test('M1: caretRestoreArgs splits the nested Toast UI pair into setSelection(start, end)', () => {
  assert.deepStrictEqual(caretRestoreArgs({ sel: [[2, 1], [2, 9]] }), [[2, 1], [2, 9]]);
  assert.equal(caretRestoreArgs({ sel: null }), null);
  assert.equal(caretRestoreArgs(null), null);
  assert.equal(caretRestoreArgs({ sel: [[2, 1]] }), null, 'a one-ended pair is not a selection');
  assert.equal(caretRestoreArgs({ sel: { from: 1, to: 2 } }), null,
    'the flat {from,to} shape this used to pass is not what setSelection takes');
});
