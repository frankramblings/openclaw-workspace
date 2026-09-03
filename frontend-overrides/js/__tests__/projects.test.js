// frontend-overrides/js/__tests__/projects.test.js
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost', hash: '' };
globalThis.history = { replaceState: () => {} };
const store = new Map();
globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class { constructor(url) { this.url = String(url); this.readyState = 1; } close() { this.readyState = 2; } };
globalThis.EventSource.CLOSED = 2;

const jsonRes = (obj, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const calls = [];
let projects = [{ id: 'p-aaaaaaaa', name: 'Plex', archived: false }];
const sessions = [{ id: 'a', name: 'A', created: 1, updated: 2, folder: null }, { id: 'b', name: 'B', created: 1, updated: 3, folder: 'p-aaaaaaaa', parent_id: 'a' }];
globalThis.fetch = (url, opts) => {
  const u = String(url); const method = (opts && opts.method) || 'GET';
  calls.push({ u, method, body: opts && opts.body });
  if (u.endsWith('/api/projects') && method === 'POST') { const p = { id: 'p-bbbbbbbb', name: JSON.parse(opts.body).name, archived: false }; projects = [...projects, p]; return Promise.resolve(jsonRes(p, 201)); }
  if (u.includes('/api/projects/') && method === 'PATCH') { const body = JSON.parse(opts.body); return Promise.resolve(jsonRes({ ...projects[0], ...body })); }
  if (u.endsWith('/api/projects')) return Promise.resolve(jsonRes(projects));
  if (u.includes('/api/sessions/')) return Promise.resolve(jsonRes({}));
  if (u.includes('/api/sessions')) return Promise.resolve(jsonRes(sessions));
  if (u.includes('/api/history/')) return Promise.resolve(jsonRes({ history: [] }));
  return Promise.resolve(jsonRes({}));
};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r)); };

function freshState(activeId) {
  const state = { draft: '', pendingAttach: [], surface: 'chat', live: { projects: projects.slice(), chat: { activeId, model: 'm', thread: [], sessions: sessions.map((s) => ({ ...s })) } } };
  runtime.state = state; runtime.render = () => {};
  actions.rebuildThreadGroups();
  return state;
}

test('selectSession mirrors folder and parent onto chat', async () => {
  const state = freshState('a');
  await actions.selectSession('b');
  await drain();
  assert.equal(state.live.chat.folder, 'p-aaaaaaaa');
  assert.equal(state.live.chat.parentId, 'a');
});

test('moveToProject is optimistic and PATCHes folder; empty target unfiles', async () => {
  const state = freshState(null);
  calls.length = 0;
  await actions.moveToProject('a|p-aaaaaaaa');
  await drain();
  assert.equal(state.live.chat.sessions.find((s) => s.id === 'a').folder, 'p-aaaaaaaa');
  const patch = calls.find((c) => c.u.endsWith('/api/session/a') && c.method === 'PATCH');
  assert.ok(patch, 'PATCH sent');
  assert.ok(state.live.chat.groups.some((g) => g.kind === 'project' && g.rows.some((r) => r.id === 'a')));
  await actions.moveToProject('a|');
  await drain();
  assert.equal(state.live.chat.sessions.find((s) => s.id === 'a').folder, null);
  // Amendment A: unfiling goes through the dedicated route, not a PATCH with
  // an empty-string folder (FastAPI drops empty-string form values, so that
  // PATCH can never actually unfile).
  const unfilePost = calls.find((c) => c.u.endsWith('/api/session/a/unfile') && c.method === 'POST');
  assert.ok(unfilePost, 'unfile POST sent');
});

test('moveToProject to "new" prompts, creates the project, then files', async () => {
  const state = freshState(null);
  globalThis.window.prompt = () => 'Podcast pipeline';
  calls.length = 0;
  await actions.moveToProject('a|new');
  await drain();
  assert.ok(calls.some((c) => c.u.endsWith('/api/projects') && c.method === 'POST'));
  assert.equal(state.live.chat.sessions.find((s) => s.id === 'a').folder, 'p-bbbbbbbb');
  assert.ok(state.live.projects.some((p) => p.id === 'p-bbbbbbbb'));
  globalThis.window.prompt = () => null;
  calls.length = 0;
  await actions.moveToProject('a|new');
  await drain();
  assert.ok(!calls.some((c) => c.method === 'POST'), 'cancelled prompt creates nothing');
});

test('archiveProject flips the flag locally and PATCHes', async () => {
  const state = freshState(null);
  calls.length = 0;
  await actions.archiveProject('p-aaaaaaaa');
  await drain();
  assert.equal(state.live.projects.find((p) => p.id === 'p-aaaaaaaa').archived, true);
  assert.ok(calls.some((c) => c.u.endsWith('/api/projects/p-aaaaaaaa') && c.method === 'PATCH'));
  assert.ok(!state.live.chat.groups.some((g) => g.kind === 'project' && g.meta.id === 'p-aaaaaaaa'), 'archived project leaves the sidebar');
});
