import { test } from 'node:test';
import assert from 'node:assert';
import { reconcileDecision } from '../redesign/live/reconcile-decision.js';

const d = (input) => reconcileDecision(input);

test('active server turn attaches even with no local state', () => {
  assert.equal(d({ active: true, lastTurnStatus: null, hasLocalLive: false, localSessionMatches: true }), 'attach');
});

test('active server turn attaches over stale local state', () => {
  assert.equal(d({ active: true, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true }), 'attach');
});

test('idle both sides is a no-op', () => {
  assert.equal(d({ active: false, lastTurnStatus: null, hasLocalLive: false, localSessionMatches: true }), 'none');
});

test('never finalize a turn belonging to a different session', () => {
  assert.equal(d({ active: false, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: false }), 'none');
});

test('restart-killed turn finalizes as interrupted', () => {
  assert.equal(d({ active: false, lastTurnStatus: 'interrupted', hasLocalLive: true, localSessionMatches: true }), 'finalize-interrupted');
});

test('turn that ended while away finalizes as stale', () => {
  assert.equal(d({ active: false, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true }), 'finalize-stale');
});
