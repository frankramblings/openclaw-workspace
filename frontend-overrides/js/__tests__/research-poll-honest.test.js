// Task 2.3: research honesty — action-level tests for live/research.js.
//
// Covers the audit findings:
//   - an SSE 'error' event during a run must render an honest error state
//     (never a fake "done" with an empty summary and dead buttons);
//   - the run-start response's rid becomes state.live.research.lastRid the
//     instant /start resolves, not only when the run finishes normally — so
//     Report/Discuss keep working no matter which path ends the run;
//   - Retry re-runs the SAME query (startResearch reads state.researchQuery,
//     which a failure must never clear);
//   - if the SSE stream goes silent (service restart etc.) while the backend
//     job keeps going, a poll fallback (GET /api/research/status/{rid}, every
//     POLL_INTERVAL_MS) independently notices the job finished/failed and
//     renders truthfully instead of spinning "Researching…" forever;
//   - a job that never resolves is given an honest timeout instead of an
//     infinite spinner.
//
// pollDecision — the pure "when to poll / when to give up" logic — is tested
// standalone first, with no timers at all.
//
// live/research.js is a browser module (fetch/EventSource) — same minimal
// shim set as chat-turn-epoch.test.js / model-sheet-retry.test.js.
import { test, mock } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

let lastES = null;
globalThis.EventSource = class {
  constructor(url) { this.url = String(url); this.readyState = 1; lastES = this; }
  close() { this.readyState = 2; }
};
globalThis.EventSource.CLOSED = 2;

const { runtime } = await import('../redesign/live/runtime.js');
const { actions, pollDecision, POLL_INTERVAL_MS, POLL_TIMEOUT_MS } = await import('../redesign/live/research.js');

const jsonRes = (obj) => ({
  ok: true,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

function freshState(query = 'compare podcast hosts') {
  return { researchQuery: query, research: 'idle', resCfg: { rounds: 'Auto' }, live: {} };
}

function sendSSE(payload) {
  if (lastES && lastES.onmessage) lastES.onmessage({ data: JSON.stringify(payload) });
}

function wireFetch(router) {
  globalThis.fetch = async (url, opts) => {
    const path = String(url).replace('http://localhost', '');
    const hit = router(path, opts);
    if (hit) return hit;
    return jsonRes({});
  };
}

// setImmediate is deliberately NOT part of the faked timer set below — it
// stays real, so awaiting one gives the entire (fake-timer-free) microtask
// chain a chance to fully settle after a mock.timers.tick().
const flush = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// pollDecision — pure, no timers needed
// ---------------------------------------------------------------------------
test('pollDecision: done wins regardless of elapsed time', () => {
  assert.equal(pollDecision({ elapsedMs: 0, status: 'done' }), 'done');
  assert.equal(pollDecision({ elapsedMs: 999999999, status: 'done' }), 'done');
});

test('pollDecision: error and cancelled both surface as error', () => {
  assert.equal(pollDecision({ elapsedMs: 100, status: 'error' }), 'error');
  assert.equal(pollDecision({ elapsedMs: 100, status: 'cancelled' }), 'error');
});

test('pollDecision: still running (or a transient poll failure) under the cap just keeps polling', () => {
  assert.equal(pollDecision({ elapsedMs: 1000, status: 'running' }), 'continue');
  assert.equal(pollDecision({ elapsedMs: 1000, status: undefined }), 'continue');
});

test('pollDecision: gives up honestly once the timeout is reached', () => {
  assert.equal(pollDecision({ elapsedMs: 5000, status: 'running', timeoutMs: 5000 }), 'timeout');
  assert.equal(pollDecision({ elapsedMs: 4999, status: 'running', timeoutMs: 5000 }), 'continue');
});

test('POLL_INTERVAL_MS matches the ~20s cadence from the brief', () => {
  assert.equal(POLL_INTERVAL_MS, 20000);
});

// ---------------------------------------------------------------------------
// action-level behavior
// ---------------------------------------------------------------------------

test('startResearch sets lastRid the instant /start resolves, before any SSE event ever fires', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/research/start') return jsonRes({ session_id: 'rid-1' });
  });
  try {
    await actions.startResearch();
    assert.equal(state.research, 'running');
    assert.equal(state.live.research.lastRid, 'rid-1', 'lastRid set from the start response, not only on finish');
  } finally {
    await actions.resetResearch();
    delete globalThis.fetch;
  }
});

test('an SSE error event renders an honest error state, never a fake "done"', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/research/start') return jsonRes({ session_id: 'rid-2' });
  });
  try {
    await actions.startResearch();
    sendSSE({ phase: 'searching', error: 'brain timed out' });
    assert.equal(state.research, 'error');
    assert.equal(state.researchError, 'brain timed out');
    assert.equal(state.live.research.lastRid, 'rid-2', 'lastRid still set — Retry/report buttons keep working');
  } finally {
    await actions.resetResearch();
    delete globalThis.fetch;
  }
});

test('Retry after an error re-runs the SAME query — a failure never clears researchQuery', async () => {
  const state = freshState('who won the election');
  runtime.state = state;
  runtime.render = () => {};
  const starts = [];
  wireFetch((path, opts) => {
    if (path === '/api/research/start') {
      starts.push(JSON.parse(opts.body).query);
      return jsonRes({ session_id: `rid-retry-${starts.length}` });
    }
  });
  try {
    await actions.startResearch();
    sendSSE({ error: 'boom' });
    assert.equal(state.research, 'error');
    assert.equal(state.researchQuery, 'who won the election', 'query text survives the failure');

    await actions.startResearch(); // what the error card's Retry button fires
    assert.equal(state.research, 'running');
    assert.deepEqual(starts, ['who won the election', 'who won the election']);
  } finally {
    await actions.resetResearch();
    delete globalThis.fetch;
  }
});

test('poll fallback: a silent stream still renders done once the poll notices the job finished', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/research/start') return jsonRes({ session_id: 'rid-3' });
    if (path === '/api/research/status/rid-3') return jsonRes({ status: 'done' });
    if (path === '/api/research/result-peek/rid-3') return jsonRes({ result: 'The finding is X.' });
    if (path.startsWith('/api/research/library')) return jsonRes({ research: [] });
  });
  try {
    await actions.startResearch();
    assert.equal(state.research, 'running');

    // The SSE stream never delivers anything (sendSSE is never called) — only
    // the poll fallback can notice this run is actually done.
    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();

    assert.equal(state.research, 'done', 'poll fallback rendered done even though the stream stayed silent');
    assert.equal(state.live.research.lastRid, 'rid-3');
  } finally {
    await actions.resetResearch();
    delete globalThis.fetch;
    mock.timers.reset();
  }
});

test('poll fallback: a job the poll keeps seeing as "running" past the cap gives up with an honest timeout message', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/research/start') return jsonRes({ session_id: 'rid-4' });
    if (path === '/api/research/status/rid-4') return jsonRes({ status: 'running' });
  });
  try {
    await actions.startResearch();
    const ticks = Math.ceil(POLL_TIMEOUT_MS / POLL_INTERVAL_MS);
    for (let i = 0; i < ticks; i++) {
      mock.timers.tick(POLL_INTERVAL_MS);
      await flush();
    }
    assert.equal(state.research, 'error');
    assert.match(state.researchError, /taking longer/i);
  } finally {
    await actions.resetResearch();
    delete globalThis.fetch;
    mock.timers.reset();
  }
});

test('poll fallback: an errored/cancelled job is also rendered honestly, not left spinning', async () => {
  mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const state = freshState();
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/research/start') return jsonRes({ session_id: 'rid-5' });
    if (path === '/api/research/status/rid-5') return jsonRes({ status: 'cancelled' });
  });
  try {
    await actions.startResearch();
    mock.timers.tick(POLL_INTERVAL_MS);
    await flush();
    assert.equal(state.research, 'error');
    assert.equal(state.live.research.lastRid, 'rid-5');
  } finally {
    await actions.resetResearch();
    delete globalThis.fetch;
    mock.timers.reset();
  }
});
