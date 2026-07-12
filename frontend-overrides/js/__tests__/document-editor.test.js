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

const { saveTarget, resetBufferIdentity, shouldWarnBeforeUnload, makeSaveGuard } = await import('../redesign/live/document-editor.js');

function baseDoc(overrides) {
  return Object.assign({
    open: true, id: null, title: '', status: '',
    wsPath: null, wsRootKey: null, wsMtimeNs: null, wsAbsPath: null,
    readOnly: false, loadFailed: false, saveFailed: false,
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

