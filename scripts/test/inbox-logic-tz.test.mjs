// Timezone-pinned tests for inbox-logic date/time functions.
// MUST set TZ before any Date operations.
process.env.TZ = 'America/New_York';

import assert from 'node:assert/strict';
import { snoozeUntilMs, dueChipToISO } from '../../frontend-overrides/js/redesign/live/inbox-logic.js';

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

// "fri" on Friday evening → should return NEXT Friday (7 days out in LOCAL time, not UTC confusion)
// This fixes the UTC bug: old code would interpret Friday evening as Saturday in UTC
// and return a different day. New code stays in LOCAL time.
assert.equal(dueChipToISO('fri', FRI_2330_NYC), '2026-07-17',
  'fri chip on Friday evening returns next Friday (7 days out in LOCAL time)');

// "fri" on Thursday → next Friday
const THU_1200_NYC = new Date('2026-07-09T12:00:00').getTime();
assert.equal(dueChipToISO('fri', THU_1200_NYC), '2026-07-10',
  'fri chip on Thursday returns tomorrow (Friday)');

// "fri" on Saturday → next Friday (7 days out)
const SAT_1200_NYC = new Date('2026-07-11T12:00:00').getTime();
assert.equal(dueChipToISO('fri', SAT_1200_NYC), '2026-07-17',
  'fri chip on Saturday returns next Friday');

// "nextweek" (Monday) on Friday evening → next Monday (not a week+1 days)
assert.equal(dueChipToISO('nextweek', FRI_2330_NYC), '2026-07-13',
  'nextweek (Monday) on Friday evening returns this coming Monday');

console.log('inbox-logic-tz: all timezone assertions OK');
