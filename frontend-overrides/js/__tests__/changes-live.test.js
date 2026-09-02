import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
// Node 21+ defines a real (accessor, no setter) globalThis.navigator, so a
// plain assignment throws under ESM's strict mode — override it via
// defineProperty instead (see other __tests__ files: none reassign navigator
// directly for the same reason).
Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async () => {} } }, configurable: true });

const { runtime } = await import('../redesign/live/runtime.js');
const mod = await import('../redesign/live/changes.js');

const jsonRes = (status, obj) => ({ ok: status < 300, status, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) });
const REC = { turn_id: 5, started_ms: 100, ended_ms: 200, files: [{ path: 'a.md', kind: 'modified', added: 1, removed: 1, diffable: true, shared: false, reverted: false }] };

function wire(routes) {
  const calls = [];
  globalThis.fetch = (url, opts) => {
    const u = String(url); calls.push({ url: u, opts });
    for (const [frag, res] of Object.entries(routes)) if (u.includes(frag)) return Promise.resolve(typeof res === 'function' ? res(u, opts) : res);
    return Promise.resolve(jsonRes(200, {}));
  };
  return calls;
}

test('afterTurn fetches the record with retry and attaches it to the message', async () => {
  let n = 0;
  wire({ '/api/changes/turn': () => (++n === 1 ? jsonRes(404, { ok: false }) : jsonRes(200, { ok: true, record: REC })) });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  const msg = { id: 'a1', role: 'assistant' };
  await mod.afterTurn('s1', 5, msg, { delays: [0, 0, 0] });
  assert.equal(n, 2);
  assert.equal(msg.changes.turn_id, 5);
  assert.equal(state.live.changes.records[5].turn_id, 5);
});

test('attachHistory maps session turns onto assistant messages', async () => {
  wire({ '/api/changes/session': jsonRes(200, { ok: true, turns: [{ turn_id: 5, started_ms: 100, ended_ms: 200, files: 1, added: 1, removed: 1 }] }), '/api/changes/turn': jsonRes(200, { ok: true, record: REC }) });
  const thread = [{ id: 'a0', role: 'assistant', _ts: 10 }, { id: 'a1', role: 'assistant', _ts: 150 }];
  const state = { live: { chat: { activeId: 's1', thread } } };
  runtime.state = state; runtime.render = () => {};
  await mod.attachHistory(state, 's1', thread);
  assert.equal(thread[1].changes.turn_id, 5);
  assert.equal(thread[0].changes, undefined);
});

test('changesOpen loads the diff; changesRevert posts and refreshes', async () => {
  const calls = wire({
    '/api/changes/turn': jsonRes(200, { ok: true, record: REC }),
    '/api/changes/diff': jsonRes(200, { ok: true, diffable: true, text: '-a\n+b\n', before_bytes: 1, after_bytes: 1, kind: 'modified' }),
    '/api/changes/revert': jsonRes(200, { ok: true }),
    '/api/changes/session': jsonRes(200, { ok: true, turns: [] }),
  });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  await mod.actions.changesOpen('5:a.md');
  assert.equal(state.live.changes.open.path, 'a.md');
  assert.ok(state.live.changes.open.diff.text.includes('+b'));
  assert.equal(state.compTab, 'changes');
  globalThis.confirm = () => true;
  await mod.actions.changesRevert('5:a.md');
  const rv = calls.find((c) => c.url.includes('/api/changes/revert'));
  assert.deepEqual(JSON.parse(rv.opts.body), { session: 's1', turn: 5, path: 'a.md' });
});
