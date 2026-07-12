import { test } from 'node:test';
import assert from 'node:assert';

// shortTime needs api.js's module-eval-time `location.origin` satisfied
// before live/email.js is imported — see calendar-honest.test.js for the
// same pattern (dynamic import after the global is set).
globalThis.location = { origin: 'http://localhost' };
const { shortTime } = await import('../redesign/live/email.js');

const NOW = new Date('2026-07-12T16:00:00');

test('shortTime: today → time-of-day (existing format, unchanged)', () => {
  assert.equal(shortTime('2026-07-12T04:12:00', NOW), '04:12 AM');
  assert.equal(shortTime('2026-07-12T16:12:00', NOW), '04:12 PM');
  assert.equal(shortTime('2026-07-12T00:00:00', NOW), '12:00 AM');
  assert.equal(shortTime('2026-07-12T12:00:00', NOW), '12:00 PM');
});

test('shortTime: earlier this year, not today → "Mon D" (no year, no time)', () => {
  assert.equal(shortTime('2026-06-28T09:30:00', NOW), 'Jun 28');
  assert.equal(shortTime('2026-01-05T09:30:00', NOW), 'Jan 5');
});

test('shortTime: a prior year → "M/D/YY"', () => {
  assert.equal(shortTime('2025-06-28T09:30:00', NOW), '6/28/25');
  assert.equal(shortTime('2003-01-05T09:30:00', NOW), '1/5/03');
});

test('shortTime: a future year (still "not this year") also gets M/D/YY', () => {
  assert.equal(shortTime('2027-03-09T09:30:00', NOW), '3/9/27');
});

test('shortTime: falsy/invalid input unchanged', () => {
  assert.equal(shortTime('', NOW), '');
  assert.equal(shortTime(null, NOW), '');
  assert.equal(shortTime('not-a-date', NOW), 'not-a-date');
});

test('shortTime: now just after midnight — 11:59pm yesterday is a date, not "today"', () => {
  const justPastMidnight = new Date('2026-07-12T00:05:00');
  assert.equal(shortTime('2026-07-11T23:59:00', justPastMidnight), 'Jul 11');
  assert.equal(shortTime('2026-07-12T00:01:00', justPastMidnight), '12:01 AM');
});

test('shortTime: now at Jan 1 — Dec 31 of the prior year gets the year form', () => {
  const newYear = new Date('2026-01-01T00:05:00');
  assert.equal(shortTime('2025-12-31T23:59:00', newYear), '12/31/25');
  assert.equal(shortTime('2026-01-01T00:01:00', newYear), '12:01 AM');
});

test('shortTime: defaults `now` to the real current time when omitted', () => {
  // Doesn't assert an exact value (that would be a flaky clock test) — just
  // that calling with one arg doesn't throw and returns a non-empty string
  // for "right now".
  const out = shortTime(new Date().toISOString());
  assert.ok(out.length > 0);
});
