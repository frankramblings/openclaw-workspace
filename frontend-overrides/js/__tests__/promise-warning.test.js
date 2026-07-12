import { test } from 'node:test';
import assert from 'node:assert';
import { promiseWarningText, latestAsstAtOrBefore } from '../redesign/live/promise-warning.js';

test('warning copy quotes the phrase and states the consequence', () => {
  const t = promiseWarningText("I'll let you know");
  assert.match(t, /I'll let you know/);
  assert.match(t, /no tracked task/i);
  assert.match(t, /will not be pinged/i);
});

test('missing phrase still produces honest copy', () => {
  const t = promiseWarningText('');
  assert.match(t, /follow-up was promised/i);
  assert.match(t, /will not be pinged/i);
});

test('latestAsstAtOrBefore picks the owning turn message', () => {
  const msgs = [{ id: 'a', _ts: 100 }, { id: 'b', _ts: 200 }, { id: 'c', _ts: 300 }];
  assert.equal(latestAsstAtOrBefore(msgs, 250).id, 'b');
  assert.equal(latestAsstAtOrBefore([], 250), null);
});

// A warning whose timestamp predates every assistant message's _ts (clock
// skew, or a persisted warning replayed against a thread that was pruned)
// must anchor to the OLDEST bubble, not the newest — the newest reply had
// nothing to do with a promise made before the thread even started, and
// blaming it is actively misleading.
test('a warning that predates every _ts anchors to the OLDEST bubble, not the newest', () => {
  const msgs = [{ id: 'a', _ts: 100 }, { id: 'b', _ts: 200 }, { id: 'c', _ts: 300 }];
  assert.equal(latestAsstAtOrBefore(msgs, 50).id, 'a');
});

test('a non-finite timestamp (missing/NaN) also falls back to the oldest bubble', () => {
  const msgs = [{ id: 'a', _ts: 100 }, { id: 'b', _ts: 200 }];
  assert.equal(latestAsstAtOrBefore(msgs, undefined).id, 'a');
  assert.equal(latestAsstAtOrBefore(msgs, NaN).id, 'a');
});
