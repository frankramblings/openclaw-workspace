import { test } from 'node:test';
import assert from 'node:assert';
import { shouldRecoverDroppedTurn, droppedTurnAction } from '../redesign/live/dropped-turn-decision.js';

const r = (snap) => shouldRecoverDroppedTurn(snap);

// The whole point: a turn that finished cleanly while our reader was dead must
// be recovered (pull the reply, suppress the retry) so a "Send to retry" tap
// can't start a duplicate second turn.
test('clean completion while detached → recover', () => {
  assert.equal(r({ active: false, last_turn: { status: 'ok' } }), true);
  assert.equal(r({ active: false, last_turn: { status: 'done' } }), true);
  assert.equal(r({ active: false, last_turn: { status: 'ended' } }), true);
});

// Ambiguous states must fall back to today's error+recall — never swallow a
// retry the user genuinely needs.
test('still running → do not recover (retry hits busy_stream, no dup)', () => {
  assert.equal(r({ active: true, last_turn: { status: 'ok' } }), false);
  assert.equal(r({ active: true, last_turn: null }), false);
});

test('interrupted turn → do not recover (real resend wanted)', () => {
  assert.equal(r({ active: false, last_turn: { status: 'interrupted' } }), false);
});

test('missing/unknown status → do not recover', () => {
  assert.equal(r({ active: false, last_turn: {} }), false);
  assert.equal(r({ active: false, last_turn: null }), false);
  assert.equal(r({ active: false }), false);
});

test('null/undefined snapshot → do not recover', () => {
  assert.equal(r(null), false);
  assert.equal(r(undefined), false);
});

// droppedTurnAction: the full triage a statusless mid-turn drop needs. The bug
// it fixes: a still-RUNNING turn (reader dropped, not the turn) used to fall to
// error+recall, abandoning the partial reply the user was reading ("streaming
// then disappears"). It must re-attach to the live event_store tail instead.
const a = (snap) => droppedTurnAction(snap);

test('still-active turn → reattach (keep streaming, do not abandon partial)', () => {
  assert.equal(a({ active: true }), 'reattach');
  assert.equal(a({ active: true, last_turn: { status: 'ok' } }), 'reattach');
  assert.equal(a({ active: true, last_turn: null }), 'reattach');
});

test('finished-clean while detached → recover the real reply', () => {
  assert.equal(a({ active: false, last_turn: { status: 'ok' } }), 'recover');
  assert.equal(a({ active: false, last_turn: { status: 'done' } }), 'recover');
});

test('interrupted / unknown / no snapshot → error+recall (real resend wanted)', () => {
  assert.equal(a({ active: false, last_turn: { status: 'interrupted' } }), 'error');
  assert.equal(a({ active: false, last_turn: {} }), 'error');
  assert.equal(a({ active: false }), 'error');
  assert.equal(a(null), 'error');
  assert.equal(a(undefined), 'error');
});
