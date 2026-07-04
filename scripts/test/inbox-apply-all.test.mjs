// Phase 4: "Triage with Gary" → Apply-all batch + single batch Undo.
// Exercises the real actions.applyAll → actions.undo path from inbox.js with a
// shimmed fetch, asserting: only batch-applyable recs run, 'none' is untouched,
// one toast carries the whole undo batch, and Undo reverses every action.
import assert from 'node:assert/strict';

// --- browser-global shim so the browser ES modules import under node ---------
let undoCounter = 1000;
const posted = { action: [], undo: [] };
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
  createElement: () => ({ click() {}, remove() {}, setAttribute() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {}, querySelector: () => null,
};
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  let payload = { ok: true };
  if (url.includes('/api/items/action')) { posted.action.push(body); payload = { ok: true, undoTs: ++undoCounter }; }
  else if (url.includes('/api/items/undo')) { posted.undo.push(body.ts); payload = { ok: true }; }
  else if (url.includes('/api/items')) { payload = { items: [], sources: null, errors: null }; }
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload };
};

const base = '../../frontend-overrides/js/redesign/live/';
const { actions } = await import(base + 'inbox.js');
const { runtime: rt } = await import(base + 'runtime.js');
rt.render = () => {};
rt.state = {
  dismissed: [],
  inboxTriaged: true,
  inboxTriageReviewed: false,
  inboxToast: null,
  live: { inbox: { items: [
    { id: 'g1', source: 'gmail',    who: 'A', body: 'a', meta: {}, rec: { action: 'archive' } },
    { id: 'g2', source: 'gmail',    who: 'B', body: 'b', meta: {}, rec: { action: 'archive' } },
    { id: 's1', source: 'slack',    who: 'C', body: 'c', meta: {}, rec: { action: 'mark_read' } },
    { id: 'o1', source: 'obsidian', who: 'D', body: 'd', meta: {}, rec: { action: 'add_asana' } },
    { id: 'n1', source: 'gmail',    who: 'E', body: 'e', meta: {}, rec: { action: 'none' } },
  ] } },
};

// Apply all: 4 actionable recs run; 'none' is never touched.
await actions.applyAll();
assert.equal(posted.action.length, 4, 'exactly the 4 batch-applyable recs are POSTed');
assert.deepEqual(posted.action.map((b) => b.id).sort(), ['g1', 'g2', 'o1', 's1'], 'the right items ran');
assert.ok(!rt.state.dismissed.includes('n1'), "rec 'none' stays in the feed — never applied");
assert.ok(['g1', 'g2', 's1', 'o1'].every((id) => rt.state.dismissed.includes(id)), 'applied items left the feed');
assert.ok(rt.state.inboxToast && Array.isArray(rt.state.inboxToast.undoBatch), 'one toast carries the undo batch');
assert.equal(rt.state.inboxToast.undoBatch.length, 4, 'batch holds all 4 undo tokens');
assert.equal(rt.state.inboxTriageReviewed, true, 'summary bar retires after Apply-all');

// One Undo reverses the whole batch.
const batchTokens = rt.state.inboxToast.undoBatch.slice();
await actions.undo();
assert.equal(posted.undo.length, 4, 'Undo reverses every action in the batch');
assert.deepEqual(posted.undo.slice().sort(), batchTokens.slice().sort(), 'undo hit exactly the batch tokens');
assert.equal(rt.state.inboxToast, null, 'toast cleared after undo');

console.log('inbox-apply-all: all assertions OK');
