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
  assert.equal(latestAsstAtOrBefore(msgs, 50).id, 'c');    // nothing ≤ ts → last (fallback)
  assert.equal(latestAsstAtOrBefore([], 250), null);
});
