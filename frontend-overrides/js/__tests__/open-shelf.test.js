// frontend-overrides/js/__tests__/open-shelf.test.js
// Behavioral: OPEN-shelf actions on live/chat.js (close is optimistic and
// POSTs /api/session/<id>/close; slot select and cycle pick from OPEN rows).
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost', hash: '' };
globalThis.history = { replaceState: (_s, _t, url) => { globalThis.location.hash = url; } };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { constructor(url) { this.url = String(url); this.readyState = 1; } close() { this.readyState = 2; } };
globalThis.EventSource.CLOSED = 2;

const jsonRes = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const calls = [];
const NOW = Date.now();
const sessions = [
  { id: 'a', name: 'A', created: 1, updated: NOW - 1000, opened: NOW - 1000 },
  { id: 'b', name: 'B', created: 1, updated: NOW - 2000, opened: NOW - 2000 },
  { id: 'c', name: 'C', created: 1, updated: NOW - 3000, opened: null },
];
globalThis.fetch = (url, opts) => {
  const u = String(url);
  calls.push({ u, method: (opts && opts.method) || 'GET' });
  if (u.includes('/api/sessions/')) return Promise.resolve(jsonRes({}));
  if (u.includes('/api/sessions')) return Promise.resolve(jsonRes(sessions));
  if (u.includes('/api/history/')) return Promise.resolve(jsonRes({ history: [] }));
  return Promise.resolve(jsonRes({}));
};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function freshState(activeId) {
  const state = { draft: '', pendingAttach: [], surface: 'chat', live: { chat: { activeId, model: 'm', thread: [], sessions: sessions.map((s) => ({ ...s })) } } };
  runtime.state = state; runtime.render = () => {};
  actions.rebuildThreadGroups();
  return state;
}

test('groups start with OPEN holding the opened threads in order', () => {
  const state = freshState(null);
  const g = state.live.chat.groups;
  assert.equal(g[0].kind, 'open');
  assert.deepEqual(g[0].rows.map((r) => r.id), ['a', 'b']);
});

test('closeOpen drops the row immediately and POSTs the close route', async () => {
  const state = freshState(null);
  calls.length = 0;
  await actions.closeOpen('a');
  await drain();
  assert.deepEqual(state.live.chat.groups[0].rows.map((r) => r.id), ['b']);
  assert.ok(calls.some((c) => c.u.endsWith('/api/session/a/close') && c.method === 'POST'));
});

test('selectOpenSlot and cycleOpen pick from the OPEN rows', async () => {
  const state = freshState('a');
  await actions.selectOpenSlot(2);
  await drain();
  assert.equal(state.live.chat.activeId, 'b');
  await actions.cycleOpen(-1);
  await drain();
  assert.equal(state.live.chat.activeId, 'a');
  await actions.cycleOpen(-1);   // wraps to the last open row
  await drain();
  assert.equal(state.live.chat.activeId, 'b');
  await actions.selectOpenSlot(9);   // no such slot: no change
  await drain();
  assert.equal(state.live.chat.activeId, 'b');
});

test('toggleProject persists the expanded set', () => {
  const state = freshState(null);
  actions.toggleProject('p1');
  assert.ok(state.live.chat.expandedProjects.has('p1'));
  assert.equal(store.get('oc-proj-expanded'), '["p1"]');
  actions.toggleProject('p1');
  assert.equal(store.get('oc-proj-expanded'), '[]');
});
