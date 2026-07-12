// Mobile model sheet ↔ loadModelOptions failure truth (2.5 review).
//
// The sheet's tap-to-retry state used to be a per-surface 6s-timeout
// heuristic living in mobile-sheets.js (it couldn't see the load outcome —
// live/chat.js's loadModelOptions() swallowed GET /api/models failures
// without setting any flag). The loader is now the single source of truth:
//   - it never fires two concurrent GET /api/models (in-flight guard);
//   - a failed GET sets state.live.modelsFailed and re-renders;
//   - a new attempt clears the flag (sheet flips back to "Loading models…");
//   - success sets modelGroups + clears the flag, whenever it lands.
// renderModelSheet just renders that truth. These tests drive the REAL
// loader against a mocked fetch and assert the rendered sheet at each step.
import { test } from 'node:test';
import assert from 'node:assert';

// live/chat.js is a browser module — same minimal shims as
// chat-turn-epoch.test.js (api.js reads location.origin at module load).
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/chat.js');
const { renderModelSheet } = await import('../redesign/mobile/mobile-sheets.js');

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

const CATALOG = {
  items: [{
    endpoint_id: 'claude-cli',
    endpoint_name: 'Claude-Cli',
    models: ['claude-opus-4-8'],
    models_display: ['Claude Opus 4.8'],
  }],
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// fetch mock: /api/models handled by `models()` (counted); everything else
// (i.e. /api/default-chat) resolves to empty JSON.
function wireFetch(models, counter) {
  globalThis.fetch = (url) => {
    if (String(url).includes('/api/models')) {
      counter.n += 1;
      return models();
    }
    return Promise.resolve(jsonRes({}));
  };
}

// ---- stateful: fail → retry → success ---------------------------------------

test('fail → retry → success: retry row appears on failure, retry re-fetches and recovers', async () => {
  const state = { live: {} };
  runtime.state = state;
  runtime.render = () => {};
  const counter = { n: 0 };
  let mode = 'fail';
  wireFetch(() => (mode === 'fail'
    ? Promise.reject(new Error('boom'))
    : Promise.resolve(jsonRes(CATALOG))), counter);
  try {
    await actions.loadModelOptions();
    assert.equal(state.live.modelsFailed, true, 'failure recorded as module truth');
    assert.equal(counter.n, 1);
    const failed = renderModelSheet(state);
    assert.match(failed, /tap to retry/);
    assert.match(failed, /data-act="openModelSheet"/, 'retry re-fires the loader action');
    assert.doesNotMatch(failed, /Loading models…/);

    // The retry tap (openModelSheet → loadModelOptions) — this time it works.
    mode = 'ok';
    await actions.loadModelOptions();
    assert.equal(state.live.modelsFailed, false, 'success clears the flag');
    assert.equal(counter.n, 2, 'retry actually re-fetched');
    const ok = renderModelSheet(state);
    assert.match(ok, /Claude Opus 4\.8/);
    assert.doesNotMatch(ok, /tap to retry/);
  } finally {
    delete globalThis.fetch;
  }
});

// ---- stateful: fail → late success -------------------------------------------

test('fail → late success: a retry in flight shows Loading again, then recovers when it lands', async () => {
  const state = { live: {} };
  runtime.state = state;
  runtime.render = () => {};
  const counter = { n: 0 };
  const slow = deferred();
  let mode = 'fail';
  wireFetch(() => (mode === 'fail' ? Promise.reject(new Error('boom')) : slow.promise), counter);
  try {
    await actions.loadModelOptions();
    assert.equal(state.live.modelsFailed, true);
    assert.match(renderModelSheet(state), /tap to retry/);

    // Retry fires but the GET is slow: the failure flag resets immediately so
    // the sheet honestly shows a load in progress, not a stale retry row.
    mode = 'slow';
    const p = actions.loadModelOptions();
    assert.equal(state.live.modelsFailed, false, 'a new attempt clears the failure flag');
    assert.match(renderModelSheet(state), /Loading models…/);

    // …and the late success still lands.
    slow.resolve(jsonRes(CATALOG));
    await p;
    assert.equal(state.live.modelsFailed, false);
    assert.match(renderModelSheet(state), /Claude Opus 4\.8/);
  } finally {
    delete globalThis.fetch;
  }
});

// ---- stateful: in-flight retry tap no-ops -------------------------------------

test('a retry tap while a load is already in flight fires no second GET /api/models', async () => {
  const state = { live: {} };
  runtime.state = state;
  runtime.render = () => {};
  const counter = { n: 0 };
  const slow = deferred();
  wireFetch(() => slow.promise, counter);
  try {
    const p1 = actions.loadModelOptions();
    const p2 = actions.loadModelOptions();   // impatient second tap
    assert.equal(counter.n, 1, 'in-flight guard: exactly one GET /api/models');
    slow.resolve(jsonRes(CATALOG));
    await p1;
    await p2;
    assert.equal(counter.n, 1);
    assert.match(renderModelSheet(state), /Claude Opus 4\.8/);
    assert.equal(state.live.modelsFailed, false);
  } finally {
    delete globalThis.fetch;
  }
});

// ---- render-level: the three sheet states -------------------------------------

test('renderModelSheet: no catalog + no failure = "Loading models…", no retry affordance', () => {
  const html = renderModelSheet({ live: {} });
  assert.match(html, /Loading models…/);
  assert.doesNotMatch(html, /tap to retry/);
});

test('renderModelSheet: no catalog + modelsFailed = tap-to-retry row wired to the loader', () => {
  const html = renderModelSheet({ live: { modelsFailed: true } });
  assert.match(html, /tap to retry/);
  assert.match(html, /data-act="openModelSheet"/);
  assert.doesNotMatch(html, /Loading models…/);
});

test('renderModelSheet: a populated catalog renders the model list, not a loading/retry state', () => {
  const s = {
    live: {
      modelGroups: [{ ep: 'Claude CLI', endpointId: 'claude-cli', hasTag: false, tag: '', models: [
        { id: 'claude-cli·claude-opus-4-8', mid: 'claude-opus-4-8', name: 'Claude Opus 4.8', endpointId: 'claude-cli', ep: 'Claude CLI' },
      ] }],
      defaultModel: 'claude-cli·claude-opus-4-8',
      chat: { model: 'claude-opus-4-8', endpointId: 'claude-cli' },
    },
  };
  const html = renderModelSheet(s);
  assert.match(html, /Claude Opus 4\.8/);
  assert.doesNotMatch(html, /Loading models…/);
  assert.doesNotMatch(html, /tap to retry/);
});
