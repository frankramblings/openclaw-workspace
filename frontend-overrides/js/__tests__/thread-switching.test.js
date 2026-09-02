// Behavioral: switching threads saves/restores the composer draft per thread,
// maintains the MRU list, and updates the hash. Uses the same browser shims as
// chat-turn-epoch.test.js (live/chat.js touches fetch/location/DOM at load).
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost', hash: '' };
const replaced = [];
globalThis.history = { replaceState: (_s, _t, url) => { replaced.push(url); globalThis.location.hash = url; } };
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { constructor(url) { this.url = String(url); this.readyState = 1; } close() { this.readyState = 2; } };
globalThis.EventSource.CLOSED = 2;

const jsonRes = (obj) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const sessions = [
  { id: 'sess-a', name: 'Thread A', model: 'm', created: 1, updated: 2 },
  { id: 'sess-b', name: 'Thread B', model: 'm', created: 1, updated: 3 },
];
globalThis.fetch = (url) => {
  const u = String(url);
  if (u.includes('/api/sessions/')) return Promise.resolve(jsonRes({}));       // usage
  if (u.includes('/api/sessions')) return Promise.resolve(jsonRes(sessions));
  if (u.includes('/api/history/')) return Promise.resolve(jsonRes({ history: [] }));
  return Promise.resolve(jsonRes({}));
};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');

const drain = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function freshState(activeId) {
  return { draft: '', pendingAttach: [], surface: 'chat', live: { chat: { activeId, model: 'm', thread: [] } } };
}

test('draft is saved for the thread you leave and restored when you return', async () => {
  const state = freshState('sess-a');
  runtime.state = state;
  runtime.render = () => {};
  state.draft = 'half-typed message';
  await actions.selectSession('sess-b');
  await drain();
  assert.equal(state.draft, '', 'new thread starts with an empty composer');
  assert.equal(state.live.chat.drafts['sess-a'].text, 'half-typed message');
  state.draft = 'reply for b';
  await actions.selectSession('sess-a');
  await drain();
  assert.equal(state.draft, 'half-typed message');
  assert.equal(state.live.chat.drafts['sess-b'].text, 'reply for b');
});

test('MRU tracks the order threads were opened and the hash follows the thread', async () => {
  const state = freshState('sess-a');
  runtime.state = state;
  runtime.render = () => {};
  await actions.selectSession('sess-b');
  await drain();
  await actions.selectSession('sess-a');
  await drain();
  assert.deepEqual(state.live.chat.mru.slice(0, 2), ['sess-a', 'sess-b']);
  assert.equal(replaced[replaced.length - 1], '#chat/sess-a');
  assert.equal(store.get('oc-mru'), JSON.stringify(state.live.chat.mru));
});

test('newChat saves the leaving draft and resets the hash to #chat', async () => {
  const state = freshState('sess-b');
  runtime.state = state;
  runtime.render = () => {};
  state.draft = 'unsent';
  actions.newChat();
  await drain();
  assert.equal(state.draft, '');
  assert.equal(state.live.chat.drafts['sess-b'].text, 'unsent');
  assert.equal(replaced[replaced.length - 1], '#chat');
});

test('scroll decision is applied after the thread loads', async () => {
  const state = freshState('sess-a');
  runtime.state = state;
  runtime.render = () => {};
  runtime.wantChatBottom = false;
  runtime.restoreScrollTop = null;
  state.live.chat.scroll = { 'sess-b': { top: 420, atBottom: false } };
  await actions.selectSession('sess-b');
  await drain();
  assert.equal(runtime.restoreScrollTop, 420);
  runtime.restoreScrollTop = null;
  state.live.chat.notified = new Set(['sess-a']);
  state.live.chat.scroll['sess-a'] = { top: 100, atBottom: false };
  await actions.selectSession('sess-a');
  await drain();
  assert.equal(runtime.wantChatBottom, true, 'a reply landed while away: land at the bottom');
  assert.equal(runtime.restoreScrollTop, null);
});
