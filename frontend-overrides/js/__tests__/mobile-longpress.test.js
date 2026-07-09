import { test } from 'node:test';
import assert from 'node:assert';
import { startLongPress, moveLongPress, endLongPress, resetLongPress } from '../redesign/mobile/longpress.js';

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
