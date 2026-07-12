// Regression: inbox Undo must un-hide restored cards.
// Under the (A) swipe map, a short left-flick = dismiss — the most common
// gesture — so an accidental dismiss MUST surface an Undo that restores the
// card with no server round-trip. This exercises the real actions.dismiss →
// actions.undo path from inbox.js (browser singletons shimmed for node).
//
// Task 1.5: audit found all THREE server-round-trip undo paths (toast Undo,
// batch Undo, history-drawer undoRow) restore the item server-side and
// reloadInbox, but never remove the id from state.dismissed — so the
// restored card stays hidden by filterVisible until a full page reload.
// These scenarios drive each path through the real `actions` API and assert
// filterVisible shows the id again immediately after undo.
import assert from 'node:assert/strict';

// Minimal browser-global shim so the browser ES modules import under node.
globalThis.window = globalThis;
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.document = {
  createElement: () => ({ click() {}, remove() {}, setAttribute() {}, style: {} }),
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {}, querySelector: () => null,
};
globalThis.location = { href: 'http://localhost/', origin: 'http://localhost', pathname: '/' };

// Shared fetch dispatcher: routes by URL, mutable via `mock` so each scenario
// below controls what "the server" returns without re-importing the module
// (imports are cached across a process — runtime.state is reset per scenario
// instead). Mirrors the pattern in inbox-apply-all.test.mjs.
let undoCounter = 1000;
const posted = { action: [], undo: [] };
const mock = { reloadItems: [], historyEntries: [] };
globalThis.fetch = async (url, opts) => {
  const body = opts && opts.body ? JSON.parse(opts.body) : {};
  let payload = { ok: true };
  if (url.includes('/api/items/action')) {
    posted.action.push(body);
    payload = { ok: true, undoTs: ++undoCounter };
  } else if (url.includes('/api/items/undo')) {
    posted.undo.push(body.ts);
    payload = { ok: true };
  } else if (url.includes('/api/items/history')) {
    payload = { entries: mock.historyEntries };
  } else if (url.includes('/api/items')) {
    payload = { items: mock.reloadItems, sources: null, errors: null };
  }
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => payload };
};

const base = '../../frontend-overrides/js/redesign/live/';
const { actions } = await import(base + 'inbox.js');
const { runtime: rt } = await import(base + 'runtime.js');
const { filterVisible } = await import(base + 'inbox-logic.js');
rt.render = () => {};

// --- 1. Swipe-dismiss local undo (pre-existing regression, still covered) ---
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

// --- 2. Toast Undo (server round-trip, single item, e.g. RSVP) --------------
// The card is optimistically hidden (state.dismissed) when the action posts;
// once the server confirms the undo, the id must come back out of
// state.dismissed so filterVisible shows it again immediately — no full page
// reload should be required.
{
  const item = { id: 'r1', source: 'calendar', meta: {} };
  rt.state = {
    dismissed: [],
    live: { inbox: { items: [item] } },
    inboxToast: null,
  };
  mock.reloadItems = [{ id: 'r1', source: 'calendar', title: 'Invite', actions: [], meta: {} }];

  await actions.rsvpYes('r1');
  assert.ok(rt.state.dismissed.includes('r1'), 'rsvp optimistically hides the card');
  assert.ok(rt.state.inboxToast && rt.state.inboxToast.undoTs, 'rsvp surfaces an undo-able toast');

  await actions.undo();
  assert.ok(!rt.state.dismissed.includes('r1'), 'toast Undo un-hides the restored card (state.dismissed)');
  const visible = filterVisible(rt.state.live.inbox.items, { dismissed: rt.state.dismissed });
  assert.ok(visible.some((m) => m.id === 'r1'), 'filterVisible shows the restored card again');
}

// --- 3. Batch Undo (Apply-all) — every id in the batch must un-hide --------
{
  rt.state = {
    dismissed: [],
    inboxTriaged: true,
    inboxTriageReviewed: false,
    inboxToast: null,
    live: { inbox: { items: [
      { id: 'b1', source: 'gmail', who: 'A', body: 'a', meta: {}, rec: { action: 'archive' } },
      { id: 'b2', source: 'gmail', who: 'B', body: 'b', meta: {}, rec: { action: 'mark_read' } },
    ] } },
  };
  mock.reloadItems = [
    { id: 'b1', source: 'gmail', title: 'A', actions: [], meta: {} },
    { id: 'b2', source: 'gmail', title: 'B', actions: [], meta: {} },
  ];

  await actions.applyAll();
  assert.ok(rt.state.dismissed.includes('b1') && rt.state.dismissed.includes('b2'), 'apply-all hides the batch');
  assert.ok(rt.state.inboxToast && Array.isArray(rt.state.inboxToast.undoBatch), 'toast carries the undo batch');

  await actions.undo();
  assert.ok(!rt.state.dismissed.includes('b1') && !rt.state.dismissed.includes('b2'),
    'batch Undo un-hides every restored card');
  const visible = filterVisible(rt.state.live.inbox.items, { dismissed: rt.state.dismissed });
  assert.ok(visible.some((m) => m.id === 'b1') && visible.some((m) => m.id === 'b2'),
    'filterVisible shows both restored cards again');
}

// --- 4. History-drawer per-row Undo -----------------------------------------
{
  rt.state = {
    dismissed: ['h1'],
    inboxHistory: [{ id: 'h1', source: 'gmail', title: 'H', action: 'archive', ts: 555, undo: {}, undoable: true }],
    inboxToast: null,
    live: { inbox: { items: [] } },
  };
  mock.reloadItems = [{ id: 'h1', source: 'gmail', title: 'H', actions: [], meta: {} }];
  mock.historyEntries = [];

  await actions.undoRow('555');
  assert.ok(!rt.state.dismissed.includes('h1'), 'history-drawer undoRow un-hides the restored card');
  const visible = filterVisible(rt.state.live.inbox.items, { dismissed: rt.state.dismissed });
  assert.ok(visible.some((m) => m.id === 'h1'), 'filterVisible shows the row-undone card again');
}

console.log('inbox-undo: all assertions OK');
