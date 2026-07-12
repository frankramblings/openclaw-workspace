import { test } from 'node:test';
import assert from 'node:assert';
import { fadeDecision } from '../redesign/live/jobs.js';

// fadeDecision is the pure core of the empty-panel auto-collapse: once the
// job list empties, nothing else necessarily re-invokes render() (the feed
// only notifies on a real change), so render() must schedule exactly one
// timer to re-check itself at the TTL boundary — otherwise the last terminal
// job disappearing leaves an empty "Jobs" pill on screen forever.

test('first empty render (no timer yet) starts the window and asks for one timer', () => {
  const d = fadeDecision({ emptySince: 0, now: 1000, hasTimer: false, ttlMs: 4000 });
  assert.equal(d.emptySince, 1000);   // window starts now
  assert.equal(d.hide, false);        // not yet time to hide
  assert.equal(d.scheduleMs, 4000);   // schedule the single timer for the full TTL
});

test('a render mid-window with a timer already pending does not ask for a second one', () => {
  const d = fadeDecision({ emptySince: 1000, now: 2500, hasTimer: true, ttlMs: 4000 });
  assert.equal(d.emptySince, 1000);   // window is preserved, not restarted
  assert.equal(d.hide, false);
  assert.equal(d.scheduleMs, null);   // guard: never stack a second timer
});

test('a render mid-window with NO timer pending (e.g. after a stray render) still asks for one, sized to the remainder', () => {
  const d = fadeDecision({ emptySince: 1000, now: 2500, hasTimer: false, ttlMs: 4000 });
  assert.equal(d.hide, false);
  assert.equal(d.scheduleMs, 2500); // 4000 - (2500 - 1000)
});

test('once elapsed reaches the TTL, hide fires and no further timer is requested', () => {
  const d = fadeDecision({ emptySince: 1000, now: 5000, hasTimer: true, ttlMs: 4000 });
  assert.equal(d.hide, true);
  assert.equal(d.scheduleMs, null);
});

test('boundary: elapsed exactly equal to ttlMs hides (>=, not >)', () => {
  // emptySince:0 is the module's own "unset" sentinel (fresh window starts
  // at `now`), so a real in-progress window needs a non-zero anchor here.
  const d = fadeDecision({ emptySince: 1000, now: 5000, hasTimer: false, ttlMs: 4000 });
  assert.equal(d.hide, true);
});

test('past the TTL even with no timer pending still hides (does not re-arm)', () => {
  const d = fadeDecision({ emptySince: 1000, now: 9000, hasTimer: false, ttlMs: 4000 });
  assert.equal(d.hide, true);
  assert.equal(d.scheduleMs, null);
});

test('defaults ttlMs to the module FADE_AFTER_MS (4000ms) when omitted', () => {
  const notYet = fadeDecision({ emptySince: 1000, now: 4999, hasTimer: false });
  assert.equal(notYet.hide, false);
  const atBoundary = fadeDecision({ emptySince: 1000, now: 5000, hasTimer: false });
  assert.equal(atBoundary.hide, true);
});
