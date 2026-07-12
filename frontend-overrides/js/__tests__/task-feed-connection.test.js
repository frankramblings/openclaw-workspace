// Fix round 1, finding 6 (task-w2a-report.md): "reconnecting…" never appeared
// promptly because task-feed.js's es.onerror never prompted a render, and
// nothing re-rendered on a connection-state TRANSITION at all — health.js's
// tri-state copy (wired into the mobile chat header + More card since Task
// 2.2) only ever painted by coincidence, whenever some unrelated render
// happened to land afterwards. This drives a stubbed EventSource through a
// connect -> open -> message -> error cycle and asserts runtime.render()
// fires exactly once per real transition, never once per event.
//
// task-feed.js is a singleton module (one EventSource, module-scoped state) —
// this file drives it through ONE continuous scenario rather than resetting
// between test() blocks, same reasoning as the module's own header comment
// ("The ONE consumer of /api/tasks/stream").
import { test } from 'node:test';
import assert from 'node:assert';

globalThis.window = globalThis;
// _reconnect()'s fallback GET — never exercised in this scenario (we never
// let onerror's _reconnect() actually retry before the test ends), but wired
// harmlessly in case a leftover backoff timer fires after unsubscribe.
globalThis.fetch = async () => ({ ok: true, json: async () => ({ tasks: [] }) });

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

const { runtime } = await import('../redesign/live/runtime.js');
const { subscribeTasks, connectionState } = await import('../redesign/live/task-feed.js');

let renders = 0;
runtime.render = () => { renders++; };

test('connection-state transitions render exactly once each; events on an already-open stream do not', () => {
  assert.equal(connectionState(), 'idle', 'nothing has booted yet');

  // subscribeTasks() boots the singleton — one EventSource, connect attempted.
  const unsub = subscribeTasks(() => {});
  assert.ok(lastES, '_connect() constructed an EventSource');
  // readyState is still CONNECTING (0) until the stub "opens" below, so the
  // idle -> reconnecting transition should have rendered once already.
  assert.equal(connectionState(), 'reconnecting');
  assert.equal(renders, 1, 'idle -> reconnecting rendered exactly once');

  // The stream opens.
  const es = lastES;
  es.readyState = 1; // OPEN
  es.onopen();
  assert.equal(connectionState(), 'connected');
  assert.equal(renders, 2, 'reconnecting -> connected rendered exactly once');

  // A redundant onopen (defensive — real EventSources don't refire it, but
  // nothing here should re-render for a state that hasn't changed).
  es.onopen();
  assert.equal(renders, 2, 'no new render for a no-op re-open');

  // A message on an already-open stream is not a connection-state
  // transition — it flows through the normal subscriber callback, not a
  // duplicate connection render.
  es.onmessage({ data: JSON.stringify({ type: 'tasks.snapshot', tasks: [] }) });
  assert.equal(renders, 2, 'a message on an already-open stream does not itself trigger a connection-state render');

  // The stream drops.
  es.onerror();
  assert.equal(connectionState(), 'reconnecting');
  assert.equal(renders, 3, 'connected -> reconnecting rendered exactly once');

  unsub();
});
