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

// ---- catalog staleness: a long-lived client must re-fetch ---------------------

// The loader used to fetch /api/models exactly ONCE per page load, so an
// installed PWA left open for days kept its first catalog forever. When the
// gateway renamed the Claude provider (2026.9.3: provider "anthropic" +
// agentRuntime "claude-cli"), the server-side fix restored the Claude row but
// every open client kept serving the Claude-less list until a hard reload.
// Opening the picker after the TTL now re-fetches, and the newly-served models
// replace the stale catalog.
test('an open client re-fetches the catalog once it is stale, picking up new models', async () => {
  const state = { live: {} };
  runtime.state = state;
  runtime.render = () => {};
  const counter = { n: 0 };
  const CLAUDELESS = { items: [{ endpoint_id: 'openai', endpoint_name: 'OpenAI',
    models: ['gpt-5.6-sol'], models_display: ['GPT-5.6-Sol'] }] };
  let serving = CLAUDELESS;
  wireFetch(() => Promise.resolve(jsonRes(serving)), counter);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    await actions.loadModelOptions();
    assert.equal(counter.n, 1);
    assert.doesNotMatch(renderModelSheet(state), /Claude Opus 4\.8/);

    // Re-opening the picker right away must NOT re-fetch: the catalog is fresh.
    await actions.loadModelOptions();
    assert.equal(counter.n, 1, 'a fresh catalog is reused');

    // Server-side restore lands, then the client opens the picker later.
    serving = CATALOG;
    now += 61_000;
    await actions.loadModelOptions();
    assert.equal(counter.n, 2, 'a stale catalog is re-fetched');
    assert.match(renderModelSheet(state), /Claude Opus 4\.8/, 'restored models appear without a reload');
  } finally {
    Date.now = realNow;
    delete globalThis.fetch;
  }
});
