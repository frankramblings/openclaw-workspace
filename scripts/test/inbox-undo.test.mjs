// Regression: swipe-dismiss must be locally undoable.
// Under the (A) swipe map, a short left-flick = dismiss — the most common
// gesture — so an accidental dismiss MUST surface an Undo that restores the
// card with no server round-trip. This exercises the real actions.dismiss →
// actions.undo path from inbox.js (browser singletons shimmed for node).
import assert from 'node:assert/strict';

// Minimal browser-global shim so the browser ES modules import under node.
globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' };
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
  createElement: () => ({ click() {}, remove() {}, setAttribute() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {}, querySelector: () => null,
};

const base = '../../frontend-overrides/js/redesign/live/';
const { actions } = await import(base + 'inbox.js');
const { runtime: rt } = await import(base + 'runtime.js');

rt.render = () => {};
rt.state = {
  dismissed: [],
  live: { inbox: { items: [{ id: 'x1', source: 'gmail' }] } },
  inboxToast: null,
};

// Dismiss (as a swipe-flick would): card leaves the feed AND an undo-able toast appears.
await actions.dismiss('x1');
assert.ok(rt.state.dismissed.includes('x1'), 'dismiss marks the item dismissed');
assert.ok(rt.state.inboxToast, 'dismiss surfaces a toast');
assert.equal(rt.state.inboxToast.undoLocal, 'x1', 'toast carries a local-undo handle (so the Undo button renders)');

// Undo: item restored, toast cleared — no server undoTs needed.
await actions.undo();
assert.ok(!rt.state.dismissed.includes('x1'), 'undo restores the dismissed item');
assert.equal(rt.state.inboxToast, null, 'undo clears the toast');

console.log('inbox-undo: all assertions OK');
