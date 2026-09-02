// Task 3 fix round 1 — usage staleness guard + costTotal mapping.
//
// Covers (Review round 1, Important 1 + 2):
//   1. Behavioral: fetchUsage's chat.sessionUsage write is guarded against a
//      session switch that happens WHILE its /usage GET is still in flight —
//      the resolve for a session that is no longer active must not overwrite
//      the now-active session's sessionUsage (or usagePct); the active
//      session's own resolve must still write it.
//   2. Behavioral: fetchThread's costTotal mapping reads meta.cost as the
//      BARE NUMBER the backend actually sends (backend/bridge.py
//      _merge_assistant_meta sets meta["cost"] = _c["total"], a number, not
//      an object) — a bare-number metadata.cost maps to costTotal; the old
//      (wrong) `{total: N}` shape now correctly maps to null.
//
// Same minimal-browser-shim harness as chat-turn-epoch.test.js /
// chat-pipeline-tails.test.js (chat.js is a browser module; api.js reads
// `location.origin` at import time). fetchUsage/fetchThread are not exported
// — both are exercised the same way chat-pipeline-tails.test.js's staleness
// test exercises fetchThread: through the real actions.selectSession, with a
// controllable (deferred) fetch mock standing in for the network. This is
// preferred over adding a test-only export for two internal helpers whose
// only externally-observable effect (chat.sessionUsage / chat.thread[i]) is
// already reached this way, and it matches the existing pattern for the
// sibling race (chat-pipeline-tails.test.js's stale-fetchThread test) instead
// of introducing a second convention.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.EventSource = class {
  constructor(url) { this.url = String(url); this.readyState = 1; }
  close() { this.readyState = 2; }
};
globalThis.EventSource.CLOSED = 2;

const { runtime } = await import('../redesign/live/runtime.js');
const chatMod = await import('../redesign/live/chat.js');
const { actions } = chatMod;

function freshState(activeId = 'sess-1') {
  return {
    draft: '',
    pendingAttach: [],
    surface: 'chat',
    live: { chat: { activeId, model: 'test-model', thread: [] } },
  };
}

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const drainMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setImmediate(r));
};

// ---- 1. fetchUsage staleness guard (Review round 1, Important 1) ----------

test('a usage fetch resolving AFTER a newer selectSession must not overwrite the newer session\'s sessionUsage', async () => {
  const state = freshState('sess-a');
  runtime.state = state;
  const chat = state.live.chat;

  let resolveUsageA;
  const pendingUsageA = new Promise((res) => { resolveUsageA = res; });
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/sessions/sess-a/usage')) {
      // Hangs until resolveUsageA() fires below — stands in for a slow
      // network round-trip that outlives the user's session switch.
      return pendingUsageA.then(() => jsonRes({
        ok: true,
        totals: { input: 9000000, output: 9000000, cacheRead: 0, cacheWrite: 0, totalCost: 99 },
        costed: true,
        context: { usedPct: 99 },
      }));
    }
    if (u.includes('/api/sessions/sess-b/usage')) {
      return Promise.resolve(jsonRes({
        ok: true,
        totals: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalCost: 0.01 },
        costed: false,
        context: { usedPct: 10 },
      }));
    }
    if (u.includes('/api/history/')) return Promise.resolve(jsonRes({ history: [] }));
    return Promise.resolve(jsonRes({}));
  };
  runtime.render = () => {};
  try {
    const p1 = actions.selectSession('sess-a');   // blocks on the sess-a /usage fetch
    await drainMicrotasks();
    const p2 = actions.selectSession('sess-b');   // supersedes — its own /usage resolves immediately
    await p2;
    await drainMicrotasks();

    assert.equal(chat.activeId, 'sess-b');
    assert.ok(chat.sessionUsage, 'sessionUsage was populated for the now-active session');
    assert.equal(chat.sessionUsage.totals.input, 100, 'B\'s totals are showing');
    assert.equal(chat.usagePct, 10, 'B\'s context pct is showing');

    resolveUsageA();   // the stale sess-a usage fetch finally resolves
    await p1;
    await drainMicrotasks();

    assert.equal(chat.activeId, 'sess-b', 'still on B');
    assert.equal(chat.sessionUsage.totals.input, 100,
      'the stale sess-a usage response must not have overwritten B\'s sessionUsage');
    assert.equal(chat.usagePct, 10, 'the stale sess-a response must not have overwritten B\'s usagePct either');
  } finally {
    delete globalThis.fetch;
  }
});

// ---- 2. costTotal mapping (Review round 1, Important 2) -------------------

test('history costTotal maps a bare-number metadata.cost (the real backend shape); an object shape is not a number and maps to null', async () => {
  const state = freshState('sess-c');
  runtime.state = state;
  const chat = state.live.chat;

  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.includes('/api/history/sess-c')) {
      return Promise.resolve(jsonRes({
        history: [
          { role: 'assistant', content: 'reply 1', metadata: { cost: 0.42 } },
          { role: 'assistant', content: 'reply 2', metadata: { cost: { total: 1 } } },
        ],
      }));
    }
    return Promise.resolve(jsonRes({}));
  };
  runtime.render = () => {};
  try {
    await actions.selectSession('sess-c');
    await drainMicrotasks();

    assert.equal(chat.activeId, 'sess-c');
    const asst = chat.thread.filter((m) => m.role === 'assistant');
    assert.equal(asst.length, 2);
    assert.equal(asst[0].costTotal, 0.42, 'a bare-number metadata.cost (the real backend shape) maps through');
    assert.equal(asst[1].costTotal, null, 'the old {total: N} shape is not a number and must map to null');
  } finally {
    delete globalThis.fetch;
  }
});
