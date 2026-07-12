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

// ---- hasLocalLive/localFresh matrix (task 1.3): a HEALTHY local live turn
// for this session must NOT be re-attached over — beginTurn would append a
// second partial assistant bubble and orphan the first with streaming:true.
test('no attach while a healthy local live turn exists for the session', () => {
  assert.equal(d({ active: true, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true, localFresh: true }), 'none');
});

test('healthy local turn for a DIFFERENT session does not block attach', () => {
  assert.equal(d({ active: true, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: false, localFresh: true }), 'attach');
});

test('stale local turn (hb gap / dead pipe) still re-attaches', () => {
  assert.equal(d({ active: true, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true, localFresh: false }), 'attach');
});

test('bogus localFresh without any local live state still attaches', () => {
  assert.equal(d({ active: true, lastTurnStatus: null, hasLocalLive: false, localSessionMatches: true, localFresh: true }), 'attach');
});

test('localFresh is irrelevant when the server says idle', () => {
  assert.equal(d({ active: false, lastTurnStatus: null, hasLocalLive: true, localSessionMatches: true, localFresh: true }), 'finalize-stale');
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
