import { test } from 'node:test';
import assert from 'node:assert';
import { startLongPress, moveLongPress, endLongPress, resetLongPress, armSwallow, shouldSwallowClick, scheduleSwallowDisarm } from '../redesign/mobile/longpress.js';

function harness() {
  const dispatched = [];
  const clock = { now: 0 };
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, at: clock.now + ms, fired: false };
    timers.push(t);
    return t;
  };
  const clearTimer = (t) => { if (t) t.fired = true; };
  const advance = (ms) => {
    clock.now += ms;
    for (const t of timers) {
      if (!t.fired && t.at <= clock.now) { t.fired = true; t.fn(); }
    }
  };
  const dispatch = (name, arg) => dispatched.push([name, arg]);
  return { dispatch, setTimer, clearTimer, now: () => clock.now, advance, dispatched };
}

test('fires openMobileMsgSheet after 500ms hold with no movement', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { msgId: 'u1', x: 0, y: 0 }, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, [['openMobileMsgSheet', 'u1']]);
});

test('cancels when pointermove exceeds 8px', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { msgId: 'u1', x: 0, y: 0 }, h);
  moveLongPress(st, { x: 9, y: 0 }, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, []);
});

test('does not cancel when pointermove stays within 8px', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { msgId: 'u1', x: 0, y: 0 }, h);
  moveLongPress(st, { x: 7, y: 3 }, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, [['openMobileMsgSheet', 'u1']]);
});

test('cancels on pointerup before 500ms', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { msgId: 'u1', x: 0, y: 0 }, h);
  h.advance(200);
  endLongPress(st, h);
  h.advance(400);
  assert.deepStrictEqual(h.dispatched, []);
});

test('resetLongPress cancels an active hold', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { msgId: 'u1', x: 0, y: 0 }, h);
  resetLongPress(st, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, []);
});

test('startLongPress on the same target twice replaces the pending timer', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { msgId: 'u1', x: 0, y: 0 }, h);
  startLongPress(st, { msgId: 'u2', x: 5, y: 5 }, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, [['openMobileMsgSheet', 'u2']]);
});

// ---- click-swallow gate (center "+" long-press → capture sheet) -----------
// Regression: the old implementation armed a FIXED 700ms window from the
// moment the long-press fired. Holding past 450ms (fire) + 700ms (window) —
// i.e. past ~1.15s total — meant the click synthesized on release landed
// unguarded and fired "new chat" underneath the just-opened capture sheet.

test('armSwallow marks the gate active', () => {
  const gate = {};
  armSwallow(gate);
  assert.equal(shouldSwallowClick(gate), true);
});

test('an unarmed gate never swallows', () => {
  assert.equal(shouldSwallowClick({}), false);
  assert.equal(shouldSwallowClick(undefined), false);
});

test('swallow persists across an arbitrarily long hold — no fixed timer to outlast', () => {
  const gate = {};
  armSwallow(gate);
  // Simulate holding well past what used to be a fixed 700ms window; nothing
  // but an explicit pointerup-driven disarm should ever clear it.
  assert.equal(shouldSwallowClick(gate), true);
});

test('scheduleSwallowDisarm clears the gate only after the deferred tick fires', () => {
  const h = harness();
  const gate = {};
  armSwallow(gate);
  scheduleSwallowDisarm(gate, h);
  // Still armed synchronously — the click the browser fires immediately
  // after pointerup must land inside this window.
  assert.equal(shouldSwallowClick(gate), true);
  h.advance(0);
  assert.equal(shouldSwallowClick(gate), false);
});

test('scheduleSwallowDisarm is a no-op when the gate is not armed', () => {
  const h = harness();
  const gate = {};
  scheduleSwallowDisarm(gate, h);
  h.advance(0);
  assert.equal(shouldSwallowClick(gate), false);
});

test('an explicit action/arg overrides the message-sheet default', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { action: 'openConvActions', arg: 's1', x: 0, y: 0 }, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, [['openConvActions', 's1']]);
});

test('an explicit action still cancels on movement', () => {
  const h = harness();
  const st = { active: null };
  startLongPress(st, { action: 'openConvActions', arg: 's1', x: 0, y: 0 }, h);
  moveLongPress(st, { x: 0, y: 9 }, h);
  h.advance(500);
  assert.deepStrictEqual(h.dispatched, []);
});
