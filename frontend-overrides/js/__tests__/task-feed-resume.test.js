// Fix round 1, F1 (2026-08-12-honest-progress-wave1/task-5): _onVisibilityChange
// used to fire its own manual fetch(FALLBACK) alongside _connect()'s new
// EventSource. /api/tasks/stream's handler yields a tasks.snapshot as the
// very first frame on connect (backend/tasks_route.py:_stream_gen), so that
// manual fetch was always redundant — and dangerous: it could resolve AFTER
// the stream's own fresh snapshot and overwrite a just-finished row with a
// stale `running` copy (the exact bug class this task exists to kill). The
// fix deletes the manual fetch outright; this asserts a visibility resume
// never calls fetch at all — same singleton-module-scenario pattern as
// task-feed-connection.test.js (one continuous run, not per-test isolation).
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.window = globalThis;

let fetchCalls = 0;
globalThis.fetch = async () => { fetchCalls++; return { ok: true, json: async () => ({ tasks: [] }) }; };

let lastES = null;
class FakeEventSource {
  constructor(url) {
    this.url = String(url);
    this.readyState = 0; // CONNECTING
    lastES = this;
  }
  close() { this.readyState = 2; } // CLOSED
}
globalThis.EventSource = FakeEventSource;

let visible = true;
let visListener = null;
globalThis.document = {
  get visibilityState() { return visible ? 'visible' : 'hidden'; },
  addEventListener(type, cb) { if (type === 'visibilitychange') visListener = cb; },
};

const { subscribeTasks } = await import('../redesign/live/task-feed.js');

test('a visibility resume reconnects via the stream only — no manual fallback fetch races it', () => {
  const unsub = subscribeTasks(() => {});
  assert.ok(lastES, '_connect() constructed an EventSource on boot');
  assert.equal(fetchCalls, 0, 'boot itself never fetches — only a broken stream (_reconnect) would');
  assert.ok(typeof visListener === 'function', 'subscribeTasks wired a visibilitychange listener');

  const bootES = lastES;

  // Backgrounded, then resumed — the exact "phone comes out of the pocket"
  // sequence _onVisibilityChange exists to handle.
  visible = false;
  visListener();
  visible = true;
  visListener();

  assert.notEqual(lastES, bootES, 'resume tore down the old EventSource and opened a fresh one');
  assert.equal(fetchCalls, 0, 'resume must not race the stream snapshot with a manual fetch');

  unsub();
});
