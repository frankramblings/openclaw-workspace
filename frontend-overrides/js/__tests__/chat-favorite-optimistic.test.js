// toggleFavorite must update PINNED immediately: a thread now renders in several
// sections, so flipping one row copy is not enough. It stars the session record
// and rebuilds the groups before the server round trip finishes.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { close() {} };

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');
const { buildThreadGroups } = await import('../redesign/thread-groups.js');

const jsonRes = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const NOW = Date.now();

function setup(important) {
  const sessions = [{ id: 'a', name: 'A', created: 1, updated: NOW - 1000, opened: NOW - 1000, important }];
  const state = { live: { projects: [], chat: { sessions, activeId: null } }, chatMenuOpen: false };
  state.live.chat.groups = buildThreadGroups({ sessions, projects: [], running: new Set(), notified: new Set(), queued: new Set(), now: NOW, activeId: null, expanded: new Set() });
  runtime.state = state;
  runtime.render = () => {};
  return state.live.chat;
}
async function run(fn) {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };  // load() would start timers/streams; the optimistic path is what is under test
  try { return await fn(); } finally { globalThis.fetch = orig; }
}

test('starring a thread adds it to PINNED before the server round trip ends', async () => {
  const chat = setup(false);
  assert.ok(!chat.groups.some((g) => g.kind === 'pinned'));
  await run(async () => {
    const p = actions.toggleFavorite('a');
    assert.equal(chat.groups[0].kind, 'pinned', 'PINNED appears immediately');
    assert.deepEqual(chat.groups[0].rows.map((r) => r.id), ['a']);
    await p;
  });
});

test('unstarring removes the PINNED section immediately and clears every copy', async () => {
  const chat = setup(true);
  assert.equal(chat.groups[0].kind, 'pinned');
  await run(async () => {
    const p = actions.toggleFavorite('a');
    assert.ok(!chat.groups.some((g) => g.kind === 'pinned'));
    assert.ok(chat.groups.flatMap((g) => g.rows).every((r) => !r.important));
    await p;
  });
});
