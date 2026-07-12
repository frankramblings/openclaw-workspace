// Fix round 1 (task-w2a-report.md): live/index.js's loadSurface()/reload()
// load orchestration — the layer that decides loadError vs "keep the data,
// toast instead", guards retry reentrancy, and flags state.retrying.
//
// live/index.js itself only imports runtime.js (no browser globals), but
// loadSurface() dynamically imports the real per-surface module, which DOES
// need api.js's `location.origin` + a controllable global fetch — same
// minimal shim set as research-poll-honest.test.js / document-editor.test.js.
// research.js is the vehicle throughout: it's the lightest live module
// (runtime.js + api.js only) and its load() now throws on failure (finding
// 1), which is exactly what this orchestration layer needs to exercise.
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.location = { origin: 'http://localhost' };

const { runtime } = await import('../redesign/live/runtime.js');
const { loadSurface, reload } = await import('../redesign/live/index.js');

function jsonRes(obj) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// Drains the entire pending microtask queue (any number of await hops) —
// used to let a loadSurface() call reach its network fetch() before we
// inspect/advance it, without depending on how many microtask hops away
// that fetch() call actually is.
const flush = () => new Promise((r) => setTimeout(r, 0));

function freshState() { return { live: {} }; }

// ---------------------------------------------------------------------------
// Finding 2: populated surfaces survive transient refresh failures.
// ---------------------------------------------------------------------------

test('finding 2: a populated surface keeps its data and gets a toast, not loadError, on a failed refresh', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.actions = {};
  runtime.render = () => {};

  globalThis.fetch = async () => jsonRes({ research: [{ id: 'r1', query: 'q1', duration: 10, source_count: 1 }] });
  const first = await loadSurface('research', { state, actions: runtime.actions, render: runtime.render, force: true });
  assert.equal(first.ok, true);
  assert.equal(state.live.research.past.length, 1);
  assert.equal(state.loadError, undefined);

  globalThis.fetch = async () => { throw new Error('network down'); };
  const second = await loadSurface('research', { state, actions: runtime.actions, render: runtime.render, force: true });
  assert.equal(second.ok, false);
  assert.equal(state.loadError?.research, undefined, 'a populated surface must not get the error partial');
  assert.equal(state.live.research.past.length, 1, 'the existing data must survive the failed refresh');
  assert.match(state.inboxToast?.msg || '', /Refresh failed/i, 'a transient notice must replace the error partial');

  delete globalThis.fetch;
});

test('finding 2: an empty surface (nothing ever loaded) still gets the honest loadError on failure', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.actions = {};
  runtime.render = () => {};

  globalThis.fetch = async () => { throw new Error('network down'); };
  const result = await loadSurface('research', { state, actions: runtime.actions, render: runtime.render, force: true });
  assert.equal(result.ok, false);
  assert.match(state.loadError?.research || '', /network down/);
  assert.equal(state.live.research, undefined, 'nothing to show — the error partial is the honest state');

  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Finding 4: retrySurface/reload() reentrancy — a per-surface generation
// counter guards against a stale (superseded) result clobbering a newer one.
// ---------------------------------------------------------------------------

test('finding 4: a slow, superseded failure never clobbers a fast, newer success', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.actions = {};
  let renders = 0;
  const render = () => { renders++; };

  const slow = deferred();
  const fast = deferred();
  let callN = 0;
  globalThis.fetch = async () => {
    callN += 1;
    return callN === 1 ? slow.promise : fast.promise;
  };

  // Call A starts (will resolve SLOW, with a failure) — not awaited yet.
  const pA = loadSurface('research', { state, actions: runtime.actions, render, force: true });
  await flush(); // let A reach its fetch() call (claims callN === 1 / `slow`)

  // Call B starts while A is still in flight (e.g. Retry hit again, or a
  // second nav) — it preempts A rather than dedupe-waiting on it.
  const pB = loadSurface('research', { state, actions: runtime.actions, render, force: true });
  await flush(); // let B reach its own fetch() call (claims callN === 2 / `fast`)

  // B resolves FAST with success.
  fast.resolve(jsonRes({ research: [{ id: 'r-fast', query: 'fast', duration: 5, source_count: 1 }] }));
  const resultB = await pB;
  assert.equal(resultB.ok, true);
  assert.equal(state.live.research.past[0].rid, 'r-fast');

  // A resolves LATER (slow) with a failure — must be dropped as stale, not
  // applied on top of B's already-landed success.
  slow.reject(new Error('stale network failure'));
  const resultA = await pA;
  assert.equal(resultA.stale, true, 'the superseded call reports itself as stale rather than a normal failure');
  assert.equal(state.live.research.past[0].rid, 'r-fast', 'the fast success must survive the later stale failure');
  assert.equal(state.loadError?.research, undefined, 'a stale failure must never set loadError over a newer success');

  delete globalThis.fetch;
});

// Uses the 'notes' surface (also runtime.js + api.js only, same shim set) —
// deliberately NOT 'research' again: generation/committedLive bookkeeping in
// live/index.js is a module-level singleton keyed by surface name, so
// reusing 'research' here would inherit the previous test's already-committed
// data instead of starting clean.
test('finding 4: a slow, superseded SUCCESS never clobbers a fast, newer failure either', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.actions = {};
  const render = () => {};

  const slow = deferred();
  const fast = deferred();
  let callN = 0;
  globalThis.fetch = async () => {
    callN += 1;
    return callN === 1 ? slow.promise : fast.promise;
  };

  const pA = loadSurface('notes', { state, actions: runtime.actions, render, force: true }); // will resolve SLOW, success
  await flush();
  const pB = loadSurface('notes', { state, actions: runtime.actions, render, force: true }); // will resolve FAST, failure
  await flush();

  fast.reject(new Error('fast failure'));
  const resultB = await pB;
  assert.equal(resultB.ok, false);
  assert.match(state.loadError?.notes || '', /fast failure/);

  slow.resolve(jsonRes({ notes: [{ id: 'n-stale', title: 'stale note' }] }));
  const resultA = await pA;
  assert.equal(resultA.stale, true);
  assert.match(state.loadError?.notes || '', /fast failure/, 'the newer failure must still stand — a late stale success must not silently clear it');
  assert.equal(state.live.notes, undefined, 'a stale success must not populate data on top of the newer, current failure');

  delete globalThis.fetch;
});

// ---------------------------------------------------------------------------
// Finding 5: state.retrying[surface] flags a (re)load in flight, cheaply
// enough for the Retry button's disabled/spinner state.
// ---------------------------------------------------------------------------

test('finding 5: state.retrying is set synchronously (same tick) when a (re)load starts, cleared once it settles', async () => {
  const state = freshState();
  runtime.state = state;
  runtime.actions = {};

  const d = deferred();
  globalThis.fetch = async () => d.promise;

  const p = loadSurface('research', { state, actions: runtime.actions, render: () => {}, force: true });
  // No await at all yet — proves the flag lands on the SAME synchronous tick
  // as the call (so a click handler's own immediate render() already shows
  // the disabled/spinner state), not one microtask later.
  assert.equal(state.retrying?.research, true);

  d.resolve(jsonRes({ research: [] }));
  await p;
  assert.equal(state.retrying?.research, undefined, 'cleared once the load settles');

  delete globalThis.fetch;
});

test('finding 5: reload() (what retrySurface actually calls) also flags retrying synchronously', () => {
  const state = freshState();
  runtime.state = state;
  runtime.actions = {};
  runtime.render = () => {};

  const d = deferred();
  globalThis.fetch = async () => d.promise;

  reload('research');
  assert.equal(state.retrying?.research, true);

  d.resolve(jsonRes({ research: [] }));
  delete globalThis.fetch;
});
