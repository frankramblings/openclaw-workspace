import { test } from 'node:test';
import assert from 'node:assert';
import { shouldRecoverDroppedTurn } from '../redesign/live/dropped-turn-decision.js';

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
