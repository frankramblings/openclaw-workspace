// Task 1.1 regression tests: document-editor cross-write + blank-open +
// close-discard data-loss bugs.
//
// The module has plenty of DOM/Toast-UI/WebSocket wiring that isn't worth
// mocking, but it imports cleanly under Node given a few minimal browser
// shims (api.js reads `location.origin` at module-load time) — nothing else
// executes until a function is actually called. So instead of driving the
// DOM-heavy `actions.*` entry points, we test the pure decision helpers the
// implementation is built on:
//   - saveTarget(d)            — where does a save go, given buffer state?
//   - resetBufferIdentity(d)   — clearing a buffer's identity before a new
//                                 open (the actual fix for the cross-write bug)
//   - shouldWarnBeforeUnload(d, dirty) — beforeunload guard predicate
// These three cover every case in the task brief: saveTarget precedence
// after switching kinds, and loadFailed gating.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost', protocol: 'http:', host: 'localhost' };
globalThis.document = {
  querySelector: () => null,
  createElement: () => ({
    style: {}, addEventListener() {}, setAttribute() {}, append() {}, appendChild() {},
    classList: { add() {}, remove() {} },
  }),
  head: { appendChild() {} },
  body: { appendChild() {}, classList: { add() {}, remove() {} } },
  documentElement: { style: { setProperty() {} }, classList: { contains: () => false } },
  addEventListener() {},
  activeElement: null,
};
globalThis.window = { addEventListener() {}, innerWidth: 1200, toastui: null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { saveTarget, resetBufferIdentity, shouldWarnBeforeUnload, makeSaveGuard,
        libraryDocIdFor, consumeAttachDetach, selectionFromMarkdownEditor, selectionFromWysiwygText,
        shouldAcceptDocUpdate, applyExternalUpdate, __setDirtyForTest } = await import('../redesign/live/document-editor.js');
const { runtime } = await import('../redesign/live/runtime.js');

function baseDoc(overrides) {
  return Object.assign({
    open: true, id: null, title: '', status: '',
    wsPath: null, wsRootKey: null, wsMtimeNs: null, wsAbsPath: null,
    readOnly: false, loadFailed: false, saveFailed: false, attachDetached: false,
  }, overrides);
}

// ---- saveTarget --------------------------------------------------------

test('saveTarget: a Library doc with only an id targets the doc endpoint', () => {
  const d = baseDoc({ id: 'doc-1' });
  assert.deepStrictEqual(saveTarget(d), { kind: 'doc', id: 'doc-1' });
});

test('saveTarget: a workspace file targets ws with path + mtime + rootKey', () => {
  const d = baseDoc({ wsPath: 'notes/a.md', wsRootKey: 'workspace', wsMtimeNs: 123 });
  assert.deepStrictEqual(saveTarget(d), { kind: 'ws', path: 'notes/a.md', mtimeNs: 123, rootKey: 'workspace' });
});

test('saveTarget: precedence — wsPath wins over id when both are set on the same buffer', () => {
  // Documents the existing dispatch order in saveDoc. The actual bug fix is
  // that a stale wsPath must never survive into a Library-doc buffer in the
  // first place — see the resetBufferIdentity tests below.
  const d = baseDoc({ id: 'doc-2', wsPath: 'leftover.md', wsMtimeNs: 99 });
  assert.deepStrictEqual(saveTarget(d), { kind: 'ws', path: 'leftover.md', mtimeNs: 99, rootKey: 'workspace' });
});

test('saveTarget: a read-only buffer never targets a write', () => {
  const d = baseDoc({ wsPath: 'ro/file.md', wsRootKey: 'other-root', readOnly: true });
  assert.deepStrictEqual(saveTarget(d), { kind: 'none' });
});

test('saveTarget: a load-failed buffer refuses to save regardless of id/wsPath', () => {
  assert.deepStrictEqual(saveTarget(baseDoc({ id: 'doc-3', loadFailed: true })), { kind: 'none' });
  assert.deepStrictEqual(saveTarget(baseDoc({ wsPath: 'x.md', loadFailed: true })), { kind: 'none' });
});

test('saveTarget: nothing open (or no state) targets nothing', () => {
  assert.deepStrictEqual(saveTarget(baseDoc()), { kind: 'none' });
  assert.deepStrictEqual(saveTarget(baseDoc({ open: false, id: 'doc-4' })), { kind: 'none' });
  assert.deepStrictEqual(saveTarget(null), { kind: 'none' });
});

// ---- resetBufferIdentity -------------------------------------------------

test('resetBufferIdentity: switching from a workspace file to a Library doc drops the stale wsPath so autosave cannot cross-write', () => {
  // State left behind by a previous openWorkspaceFile call.
  const d = baseDoc({ wsPath: 'notes/a.md', wsRootKey: 'workspace', wsMtimeNs: 42, wsAbsPath: '/home/x/notes/a.md', readOnly: false });
  resetBufferIdentity(d);
  d.id = 'doc-9'; // openDoc assigns the new id after resetting
  assert.deepStrictEqual(saveTarget(d), { kind: 'doc', id: 'doc-9' }, 'must save to the newly-opened Library doc, not the stale workspace path');
  assert.strictEqual(d.wsPath, null);
  assert.strictEqual(d.wsAbsPath, null);
  assert.strictEqual(d.wsRootKey, null);
  assert.strictEqual(d.wsMtimeNs, null);
});

test('resetBufferIdentity: switching from a Library doc to a workspace file clears the old id, readOnly and loadFailed flags', () => {
  const d = baseDoc({ id: 'doc-1', readOnly: true, loadFailed: true, title: 'Old' });
  resetBufferIdentity(d);
  d.wsPath = 'b.md'; d.wsRootKey = 'workspace'; // openWorkspaceFile assigns after resetting
  assert.strictEqual(d.id, null);
  assert.strictEqual(d.readOnly, false);
  assert.strictEqual(d.loadFailed, false);
  assert.deepStrictEqual(saveTarget(d), { kind: 'ws', path: 'b.md', mtimeNs: null, rootKey: 'workspace' });
});

test('resetBufferIdentity: clears a stashed conflict payload from the previous buffer', () => {
  const d = baseDoc({ _incoming: 'stale text', _incomingMtimeNs: 7 });
  resetBufferIdentity(d);
  assert.strictEqual(d._incoming, null);
  assert.strictEqual(d._incomingMtimeNs, null);
});

test('resetBufferIdentity: tolerates a null/undefined docState', () => {
  assert.strictEqual(resetBufferIdentity(null), null);
});

// ---- shouldWarnBeforeUnload ----------------------------------------------

test('shouldWarnBeforeUnload: warns when the buffer is dirty', () => {
  assert.strictEqual(shouldWarnBeforeUnload(baseDoc(), true), true);
});

test('shouldWarnBeforeUnload: warns when the last save failed even if not currently dirty', () => {
  assert.strictEqual(shouldWarnBeforeUnload(baseDoc({ saveFailed: true }), false), true);
});

test('shouldWarnBeforeUnload: silent when clean and no failed save', () => {
  assert.strictEqual(shouldWarnBeforeUnload(baseDoc(), false), false);
});

test('shouldWarnBeforeUnload: silent when the editor is not open at all', () => {
  assert.strictEqual(shouldWarnBeforeUnload(baseDoc({ open: false, saveFailed: true }), true), false);
});

// ---- makeSaveGuard / isStale ----------------------------------------------
//
// saveDoc captures a guard before its network await(s) and asks it whether
// the buffer generation moved on by the time the response lands. A "stale"
// guard means openDoc/openWorkspaceFile/closeDoc reset the buffer identity
// (and bumped the module generation counter) while this save was in flight,
// so its post-await mutations (wsMtimeNs/status/hideError()/etc.) must be
// skipped rather than applied to whatever buffer is now open.

test('makeSaveGuard: not stale when the generation is unchanged by the time it is checked', () => {
  const guard = makeSaveGuard(3);
  assert.strictEqual(guard.isStale(3), false);
});

test('makeSaveGuard: stale once the generation has moved past the captured value', () => {
  const guard = makeSaveGuard(3);
  assert.strictEqual(guard.isStale(4), true);
});

test('makeSaveGuard: repeated isStale checks are pure (no internal mutation)', () => {
  const guard = makeSaveGuard(5);
  assert.strictEqual(guard.isStale(5), false);
  assert.strictEqual(guard.isStale(5), false, 'checking twice must not itself change staleness');
  assert.strictEqual(guard.isStale(6), true);
  assert.strictEqual(guard.isStale(5), false, 'a later stale check against a newer gen must not retroactively poison an earlier-gen check');
});

// ---- libraryDocIdFor -------------------------------------------------------

test('libraryDocIdFor: attached iff open + a Library doc + not detached', () => {
  assert.equal(libraryDocIdFor(baseDoc({ id: 'doc-1' })), 'doc-1');
  // workspace file (even with a stray id), closed, detached, no state
  assert.equal(libraryDocIdFor(baseDoc({ id: 'doc-1', wsPath: 'notes/a.md', wsRootKey: 'workspace' })), null);
  assert.equal(libraryDocIdFor(baseDoc({ open: false, id: 'doc-1' })), null);
  assert.equal(libraryDocIdFor(baseDoc({ id: 'doc-1', attachDetached: true })), null);
  assert.equal(libraryDocIdFor(null), null);
});

// ---- selection helpers ------------------------------------------------------
//
// Toast UI's markdown-mode getSelection() returns a NESTED pair
// [[startLine, startCh], [endLine, endCh]], 1-based on both: verified
// directly against frontend-overrides/js/vendor/toastui/toastui-editor-all.min.js
// (its nl()/ol() line<->offset converters), not the {from,to} flat offsets
// an earlier draft of this helper assumed.

test('selectionFromMarkdownEditor: converts a nested [[line,ch],[line,ch]] pair to flat offsets', () => {
  const md = 'line one\nline two\nline three\n';
  // "line two" is line 2, columns 1..9 (1-based, ch=9 is just past the 8th char)
  assert.deepStrictEqual(selectionFromMarkdownEditor(md, [[2, 1], [2, 9]]),
    { text: 'line two', from: 9, to: 17, mode: 'md', lines: [2, 2] });
});

test('selectionFromMarkdownEditor: a multi-line selection crossing a line boundary converts both endpoints correctly', () => {
  // md offsets: "alpha\nbeta\ngamma\n" -> a(0)l(1)p(2)h(3)a(4)\n(5)b(6)e(7)t(8)a(9)\n(10)g(11)...
  // start = line 1, ch 3 (1-based) -> offset 0 + (3-1) = 2
  // end   = line 2, ch 3 (1-based) -> offset 6 + (3-1) = 8 (line 2 starts at offset 6, after "alpha\n")
  const md = 'alpha\nbeta\ngamma\n';
  assert.deepStrictEqual(selectionFromMarkdownEditor(md, [[1, 3], [2, 3]]),
    { text: 'pha\nbe', from: 2, to: 8, mode: 'md', lines: [1, 2] });
});

test('selectionFromMarkdownEditor: a collapsed selection, or a malformed/missing pair, is none', () => {
  const md = 'line one\nline two\n';
  assert.equal(selectionFromMarkdownEditor(md, [[2, 1], [2, 1]]), null); // collapsed
  assert.equal(selectionFromMarkdownEditor(md, null), null);
  assert.equal(selectionFromMarkdownEditor(md, [[1, 1]]), null); // wrong shape (not a pair of pairs)
});

test('selectionFromMarkdownEditor: prefers a provided selectedText (Toast UI getSelectedText()) over slicing', () => {
  const md = 'line one\nline two\n';
  const out = selectionFromMarkdownEditor(md, [[1, 1], [1, 5]], 'line');
  assert.equal(out.text, 'line');
});

test("selectionFromWysiwygText: wraps Toast UI's getSelectedText() string; blank is no selection", () => {
  assert.deepStrictEqual(selectionFromWysiwygText('hello'),
    { text: 'hello', from: null, to: null, mode: 'wysiwyg' });
  assert.equal(selectionFromWysiwygText(''), null);
  assert.equal(selectionFromWysiwygText('   '), null);
  assert.equal(selectionFromWysiwygText(null), null);
});

// ---- shouldAcceptDocUpdate --------------------------------------------------

test('shouldAcceptDocUpdate: accepts an id-matching frame, rejects everything else', () => {
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1' }), { type: 'doc_update', doc_id: 'doc-1', content: 'x' }), true);
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1' }), { type: 'doc_update', doc_id: 'doc-2' }), false);
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1', wsPath: 'a.md' }), { type: 'doc_update', doc_id: 'doc-1' }), false);
  assert.equal(shouldAcceptDocUpdate(baseDoc({ open: false, id: 'doc-1' }), { type: 'doc_update', doc_id: 'doc-1' }), false);
  assert.equal(shouldAcceptDocUpdate(null, { type: 'doc_update', doc_id: 'doc-1' }), false);
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1' }), { type: 'other', doc_id: 'doc-1' }), false);
});

// Fix round 1, Important 1: a doc_id-matching frame with missing/null/non-string
// content must be rejected here too, before applyExternalUpdate ever touches the
// editor: this is the actual guard against a malformed frame blanking the doc.
test('shouldAcceptDocUpdate: rejects a matching frame whose content is missing, null, or not a string', () => {
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1' }), { type: 'doc_update', doc_id: 'doc-1' }), false);
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1' }), { type: 'doc_update', doc_id: 'doc-1', content: null }), false);
  assert.equal(shouldAcceptDocUpdate(baseDoc({ id: 'doc-1' }), { type: 'doc_update', doc_id: 'doc-1', content: 42 }), false);
});

test('resetBufferIdentity: clears a detached-pill flag left by the previous buffer', () => {
  const d = baseDoc({ attachDetached: true });
  resetBufferIdentity(d);
  assert.strictEqual(d.attachDetached, false);
});

// ---- consumeAttachDetach ----------------------------------------------------
//
// Spec 2.2: the pill's x detaches "for the next turn" only, not permanently.
// consumeAttachDetach is the read-and-clear step chat.js (Task 3) calls once
// per send, right after deciding whether THIS send attaches: it always
// leaves attachDetached false afterward, so the send after that re-attaches.

test('consumeAttachDetach: clears attachDetached on the live docState so the next send re-attaches', () => {
  const d = baseDoc({ id: 'doc-1', attachDetached: true });
  runtime.state = { docEditor: d };
  assert.equal(libraryDocIdFor(d), null, 'detached: this send omits active_doc_id');
  consumeAttachDetach();
  assert.strictEqual(d.attachDetached, false);
  assert.equal(libraryDocIdFor(d), 'doc-1', 'the send after that re-attaches by default');
});

test('consumeAttachDetach: a no-op with no runtime.state (never throws)', () => {
  runtime.state = null;
  assert.doesNotThrow(() => consumeAttachDetach());
});

// ---- applyExternalUpdate ----------------------------------------------------
//
// Fix round 1, Important 2: applyExternalUpdate had no direct test coverage.
// Drives docState() via runtime.state directly, the same way the
// consumeAttachDetach tests above do. editor/titleEl/statusEl/flashEl stay
// null throughout this file (ensureEditor() is never called), so the clean
// path's setMarkdown/restoreEditorCaret/flashChip calls are all no-ops and
// every mutation lands only on the plain `d` object, which is what these
// tests assert against. The module-private `dirty` flag (not part of
// docState()) is set via the __setDirtyForTest test seam.

test('applyExternalUpdate: a clean buffer applies the frame and marks it saved', () => {
  const d = baseDoc({ id: 'doc-1', status: 'Unsaved', title: 'Old title', _incoming: null });
  runtime.state = { docEditor: d };
  __setDirtyForTest(false);
  applyExternalUpdate({ type: 'doc_update', doc_id: 'doc-1', content: 'new content', title: 'New title' });
  assert.strictEqual(d.status, 'Saved');
  assert.strictEqual(d.title, 'New title');
  assert.strictEqual(d._incoming, null, 'the clean path never stashes into _incoming');
});

test('applyExternalUpdate: a dirty buffer stashes the frame into _incoming instead of overwriting the buffer', () => {
  const d = baseDoc({ id: 'doc-1', status: 'Unsaved', title: 'Mine, unsaved', _incoming: null });
  runtime.state = { docEditor: d };
  __setDirtyForTest(true);
  try {
    applyExternalUpdate({ type: 'doc_update', doc_id: 'doc-1', content: 'incoming content', title: 'Incoming title' });
    assert.strictEqual(d._incoming, 'incoming content');
    assert.strictEqual(d.title, 'Mine, unsaved', 'the local unsaved buffer must not be overwritten while dirty');
    assert.strictEqual(d.status, 'Unsaved', 'status is untouched on the conflict path');
  } finally {
    __setDirtyForTest(false); // leave the module-global flag clean for any test that runs after this one
  }
});

test('applyExternalUpdate: a malformed frame (missing/null/number content) is a no-op', () => {
  __setDirtyForTest(false);
  for (const frame of [
    { type: 'doc_update', doc_id: 'doc-1' },
    { type: 'doc_update', doc_id: 'doc-1', content: null },
    { type: 'doc_update', doc_id: 'doc-1', content: 42 },
  ]) {
    const d = baseDoc({ id: 'doc-1', status: 'Saved', title: 'Mine', _incoming: null });
    runtime.state = { docEditor: d };
    applyExternalUpdate(frame);
    assert.strictEqual(d.status, 'Saved', `status must not change for ${JSON.stringify(frame)}`);
    assert.strictEqual(d.title, 'Mine', `title must not change for ${JSON.stringify(frame)}`);
    assert.strictEqual(d._incoming, null, `_incoming must not change for ${JSON.stringify(frame)}`);
  }
});

