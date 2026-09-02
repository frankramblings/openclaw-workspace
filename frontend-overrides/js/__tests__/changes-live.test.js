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

// Fix round 1, finding 1.
test('afterTurn does not clobber a different session the user has since switched to', async () => {
  wire({ '/api/changes/turn': jsonRes(200, { ok: true, record: REC }) });
  const existingTurn = { turn_id: 9, started_ms: 1, ended_ms: 2, files: 1, added: 1, removed: 0, shared: false };
  const state = {
    live: {
      chat: { activeId: 's2', thread: [] },
      changes: { sessionId: 's2', turns: [existingTurn], records: {}, expanded: new Set(), open: null, loading: false, error: null },
    },
  };
  runtime.state = state; runtime.render = () => {};
  const msg = { id: 'a1', role: 'assistant' };
  await mod.afterTurn('s1', 5, msg, { delays: [0] });
  assert.equal(msg.changes.turn_id, 5);
  assert.equal(state.live.changes.sessionId, 's2');
  assert.deepEqual(state.live.changes.turns, [existingTurn]);
});

// Fix round 1, finding 2.
test('changesRevert does not report failure when the post-revert refresh fails', async () => {
  wire({
    '/api/changes/revert': jsonRes(200, { ok: true }),
    '/api/changes/turn': () => Promise.reject(new Error('boom')),
  });
  const toasts = [];
  runtime.actions = { toast: (msg) => toasts.push(msg) };
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  globalThis.confirm = () => true;
  await mod.actions.changesRevert('5:a.md');
  runtime.actions = null;
  assert.ok(!toasts.some((t) => /failed/i.test(t)), `unexpected failure toast: ${toasts.join(', ')}`);
  assert.ok(toasts.some((t) => /Reverted/.test(t)));
});

// Fix round 1, finding 3.
test('changesOpen sets an error state instead of throwing when the record fetch fails', async () => {
  wire({ '/api/changes/turn': () => Promise.reject(new Error('network down')) });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  await mod.actions.changesOpen('5:a.md'); // must not throw / unhandled-reject
  assert.ok(state.live.changes.error);
  assert.ok(!state.live.changes.open || !state.live.changes.open.record);
});

// Fix round 1, finding 4.
test('attachHistory fetches missing turn records concurrently, not one at a time', async () => {
  const turnsResp = {
    ok: true,
    turns: [
      { turn_id: 1, started_ms: 1_000_000, ended_ms: 1_010_000, files: 1, added: 1, removed: 0 },
      { turn_id: 2, started_ms: 1_100_000, ended_ms: 1_110_000, files: 1, added: 1, removed: 0 },
      { turn_id: 3, started_ms: 1_200_000, ended_ms: 1_210_000, files: 1, added: 1, removed: 0 },
    ],
  };
  const requestedTurnUrls = [];
  const resolvers = [];
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/changes/session')) return Promise.resolve(jsonRes(200, turnsResp));
    if (u.includes('/api/changes/turn')) {
      requestedTurnUrls.push(u);
      const tid = Number(new URL(u).searchParams.get('turn'));
      return new Promise((resolve) => {
        resolvers.push(() => resolve(jsonRes(200, { ok: true, record: { ...REC, turn_id: tid, files: [{ ...REC.files[0] }] } })));
      });
    }
    return Promise.resolve(jsonRes(200, {}));
  };
  const thread = [
    { id: 'a1', role: 'assistant', _ts: 1_005_000 },
    { id: 'a2', role: 'assistant', _ts: 1_105_000 },
    { id: 'a3', role: 'assistant', _ts: 1_205_000 },
  ];
  const state = { live: { chat: { activeId: 's1', thread } } };
  runtime.state = state; runtime.render = () => {};
  const p = mod.attachHistory(state, 's1', thread);
  // Let the session fetch's awaits resolve so attachHistory reaches the
  // per-turn Promise.all — without touching any of the deliberately-pending
  // turn-record promises above.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(requestedTurnUrls.length, 3, `expected all 3 turn fetches issued up front, got ${requestedTurnUrls.length}`);
  resolvers.forEach((r) => r());
  await p;
  assert.equal(thread[0].changes.turn_id, 1);
  assert.equal(thread[1].changes.turn_id, 2);
  assert.equal(thread[2].changes.turn_id, 3);
});

test('opening a path uses the shell-mobile latch, not a media query, for the sheet', async () => {
  wire({ '/api/changes/turn': jsonRes(200, { ok: true, record: REC }), '/api/changes/diff': jsonRes(200, { ok: true, diffable: true, text: 'x' }) });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  const classes = new Set();
  const prevDoc = globalThis.document;
  // A 1024 px media query would have matched here; the shell latch must not.
  globalThis.matchMedia = () => ({ matches: true });
  globalThis.document = { querySelector: () => null, documentElement: { classList: { contains: (c) => classes.has(c) } } };
  try {
    await mod.actions.changesOpen('5:a.md');
    assert.notEqual(state.companionSheetOpen, true);
    classes.add('shell-mobile');
    await mod.actions.changesOpen('5:a.md');
    assert.equal(state.companionSheetOpen, true);
    assert.equal(state.companionTab, 'changes');
  } finally {
    globalThis.document = prevDoc;
    delete globalThis.matchMedia;
  }
});

test('afterTurn ignores a zero-file record instead of listing it', async () => {
  wire({ '/api/changes/turn': jsonRes(200, { ok: true, record: { turn_id: 7, started_ms: 1, ended_ms: 2, files: [] } }) });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  const msg = { id: 'a1', role: 'assistant' };
  await mod.afterTurn('s1', 7, msg, { delays: [0] });
  assert.equal(msg.changes, undefined);
  assert.equal((state.live.changes && state.live.changes.turns || []).length, 0);
});

test('changesRevert with a cancelled confirm makes no request', async () => {
  const calls = wire({});
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  const prev = globalThis.confirm;
  globalThis.confirm = () => false;
  try {
    await mod.actions.changesRevert('5:a.md');
  } finally {
    if (prev === undefined) delete globalThis.confirm; else globalThis.confirm = prev;
  }
  assert.equal(calls.length, 0);
});

test('changesRevert reads 409 off the error status, not the message text', async () => {
  wire({ '/api/changes/revert': jsonRes(409, { ok: false, reason: 'file_changed_since' }) });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  const toasts = [];
  runtime.actions = { toast: (m) => toasts.push(m) };
  const prev = globalThis.confirm;
  globalThis.confirm = () => true;
  try {
    await mod.actions.changesRevert('5:a.md');
  } finally {
    if (prev === undefined) delete globalThis.confirm; else globalThis.confirm = prev;
    runtime.actions = undefined;
  }
  assert.match(toasts[0], /changed since this turn/);
});

test('changesRevert stops refreshing when the thread switched during the confirm', async () => {
  const calls = wire({ '/api/changes/revert': jsonRes(200, { ok: true }) });
  const state = { live: { chat: { activeId: 's1', thread: [] } } };
  runtime.state = state; runtime.render = () => {};
  const prev = globalThis.confirm;
  globalThis.confirm = () => { state.live.chat.activeId = 's2'; return true; };
  try {
    await mod.actions.changesRevert('5:a.md');
  } finally {
    if (prev === undefined) delete globalThis.confirm; else globalThis.confirm = prev;
  }
  assert.equal(calls.filter((c) => c.url.includes('/api/changes/turn')).length, 0);
  assert.equal(calls.filter((c) => c.url.includes('/api/changes/diff')).length, 0);
});
