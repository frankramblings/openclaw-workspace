// Timezone-pinned tests for inbox-logic date/time functions.
// MUST set TZ before any Date operations.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { snoozeUntilMs, dueChipToISO } from '../redesign/live/inbox-logic.js';

// --- snoozeUntilMs: snooze times use LOCAL time, not UTC ---
// Saturday 2026-07-11 23:30 in America/New_York (which is 2026-07-12 03:30 UTC)
const SAT_2326_NYC = new Date('2026-07-11T23:30:00').getTime();
const sundayMorning = snoozeUntilMs('tomorrow', SAT_2326_NYC);
const sundayDate = new Date(sundayMorning);
assert.equal(sundayDate.getFullYear(), 2026, 'tomorrow year');
assert.equal(sundayDate.getMonth(), 6, 'tomorrow month (0-indexed July=6)');
assert.equal(sundayDate.getDate(), 12, 'tomorrow date is July 12 (Sunday)');
assert.equal(sundayDate.getHours(), 9, 'tomorrow time is 09:00 LOCAL (not 04:00 UTC)');
assert.equal(sundayDate.getMinutes(), 0, 'tomorrow minutes are :00');

// nextweek from Saturday → next Saturday at 09:00 LOCAL
const nextSat = snoozeUntilMs('nextweek', SAT_2326_NYC);
const nextSatDate = new Date(nextSat);
assert.equal(nextSatDate.getDate(), 18, 'nextweek is 7 days from Saturday = July 18');
assert.equal(nextSatDate.getHours(), 9, 'nextweek time is 09:00 LOCAL');

// later is still +4 hours (not timezone-affected)
const later = snoozeUntilMs('later', SAT_2326_NYC);
assert.equal(later - SAT_2326_NYC, 4 * 3600000, 'later is always +4 hours');

// --- dueChipToISO: due dates use LOCAL day boundaries, not UTC ---
// Friday 2026-07-10 23:30 NYC (= 2026-07-11 03:30 UTC)
const FRI_2330_NYC = new Date('2026-07-10T23:30:00').getTime();

// "today" at Friday 23:30 local → still Friday
assert.equal(dueChipToISO('today', FRI_2330_NYC), '2026-07-10',
  'today chip at 23:30 local returns TODAY\'s date, not tomorrow UTC');

// "tomorrow" at Friday 23:30 local → Saturday (not UTC Sunday)
assert.equal(dueChipToISO('tomorrow', FRI_2330_NYC), '2026-07-11',
  'tomorrow chip at 23:30 local returns tomorrow in LOCAL time');

// --- fri/nextweek: fixtures picked to actually DIVERGE from the old UTC code ---
// The old code (`d.getUTCDay()` + `new Date(nowMs).toISOString()` arithmetic)
// doesn't diverge from the new LOCAL code on every fixture: when nowMs crosses
// midnight UTC, the OLD math's day-of-week is 1 higher than LOCAL's AND its
// epoch anchor (nowMs) already sits on that later UTC calendar day — for most
// starting days those two effects cancel out and OLD lands on the same date as
// NEW even though it's computing in the wrong timezone. That's why
// FRI_2330_NYC×'fri' (both -> 2026-07-17), THU_1200_NYC×'fri' (both ->
// 2026-07-10, no midnight crossing at noon), SAT_1200_NYC×'fri' (both ->
// 2026-07-17), and FRI_2330_NYC×'nextweek' (both -> 2026-07-13) are ALL
// non-discriminating — verified by running both implementations side by side.
// Algebraically (target dow T, local dow L, add = ((T-L+7)%7)||7 with the
// analogous OLD add computed from (L+1)%7 and re-anchored one day later), the
// two only diverge when the OLD side's dow hits the "today IS chip day" wrap
// case that the LOCAL side doesn't (or vice versa) — which happens uniquely at
// LOCAL Thursday evening for 'fri' (target Friday) and LOCAL Sunday evening
// for 'nextweek' (target Monday), since those are the only local days whose
// UTC-crossed calendar day equals the target day itself.

// "fri" on Thursday evening (LOCAL) — UTC calendar day is already Friday.
// Thursday 2026-07-09 20:15 NYC = 2026-07-10T00:15:00Z (Friday UTC).
// LOCAL: today is Thursday -> chip means "tomorrow" -> 2026-07-10.
// OLD (UTC): dow===Friday hits the "today IS Friday" wrap -> +7 days from the
// already-next-day UTC anchor -> 2026-07-17. Confirmed different from LOCAL.
const THU_2015_NYC = new Date('2026-07-09T20:15:00').getTime();
assert.equal(dueChipToISO('fri', THU_2015_NYC), '2026-07-10',
  'fri chip Thursday evening (LOCAL) returns tomorrow, NOT the OLD UTC week-wrap (2026-07-17)');

// Same LOCAL day, later in the crossing window (23:30) — still Thursday LOCAL,
// still Friday UTC. LOCAL -> 2026-07-10; OLD (UTC) -> 2026-07-17 (same bug).
const THU_2330_NYC = new Date('2026-07-09T23:30:00').getTime();
assert.equal(dueChipToISO('fri', THU_2330_NYC), '2026-07-10',
  'fri chip late Thursday evening (LOCAL) still returns tomorrow, not OLD\'s 2026-07-17');

// "nextweek" (Monday) on Sunday evening (LOCAL) — UTC calendar day is already Monday.
// Sunday 2026-07-12 20:15 NYC = 2026-07-13T00:15:00Z (Monday UTC).
// LOCAL: today is Sunday -> chip means "tomorrow" -> 2026-07-13.
// OLD (UTC): dow===Monday hits the "today IS Monday" wrap -> +7 days from the
// already-next-day UTC anchor -> 2026-07-20. Confirmed different from LOCAL.
const SUN_2015_NYC = new Date('2026-07-12T20:15:00').getTime();
assert.equal(dueChipToISO('nextweek', SUN_2015_NYC), '2026-07-13',
  'nextweek chip Sunday evening (LOCAL) returns tomorrow, NOT the OLD UTC week-wrap (2026-07-20)');

console.log('inbox-logic-tz: all timezone assertions OK');
