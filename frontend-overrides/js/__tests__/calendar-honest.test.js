import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mCalendar } from '../redesign/mobile/mobile-surfaces.js';
import { monthWindow } from '../redesign/live/calendar-logic.js';

const calState = (live) => ({ surface: 'calendar', quick: '', live });

test('desktop calendar toolbar controls are wired', () => {
  const html = renderCenter(calState({ calendar: { cells: [{ date: 1 }], month: 'July 2026' } }));
  assert.match(html, /data-act="calPrev"/);
  assert.match(html, /data-act="calToday"/);
  assert.match(html, /data-act="calNext"/);
});

test('desktop calendar drops the dead Week/Agenda view switcher', () => {
  const html = renderCenter(calState({ calendar: { cells: [{ date: 1 }], month: 'July 2026' } }));
  assert.doesNotMatch(html, />Week</);
  assert.doesNotMatch(html, />Agenda</);
});

test('desktop calendar shows an empty state instead of a void grid', () => {
  const html = renderCenter(calState({}));
  assert.match(html, /cal-empty/);
  assert.doesNotMatch(html, /class="cal-grid"/);
});

test('monthWindow shifts the view month but keeps today real', () => {
  const real = new Date(2026, 6, 10); // Jul 10 2026
  const w0 = monthWindow(real, 0);
  assert.equal(w0.first.getMonth(), 6);
  assert.equal(w0.first.getDate(), 1);
  const w1 = monthWindow(real, 1);
  assert.equal(w1.first.getMonth(), 7); // August
  assert.equal(w1.today.getDate(), 10); // today unchanged
  const wBack = monthWindow(real, -13);
  assert.equal(wBack.first.getFullYear(), 2025);
  assert.equal(wBack.first.getMonth(), 5); // June 2025
});

test('monthWindow fetch range always covers the grid and the agenda window', () => {
  const real = new Date(2026, 6, 10);
  for (const off of [0, 3, -6]) {
    const w = monthWindow(real, off);
    assert.ok(w.fetchStart <= w.gridStart, `fetchStart covers grid (off ${off})`);
    assert.ok(w.fetchStart <= w.today, `fetchStart covers today (off ${off})`);
    assert.ok(w.fetchEnd > w.gridEnd, `fetchEnd covers grid (off ${off})`);
    assert.ok(w.fetchEnd >= new Date(2026, 6, 18), `fetchEnd covers today+8 (off ${off})`);
  }
});

test('mobile calendar derives month and year from live data (no hardcoded 2026)', () => {
  const html = mCalendar({ live: { calendar: { month: 'March 2027', week: [], agenda: [] } } });
  assert.match(html, />March</);
  assert.match(html, />2027</);
});

test('mobile calendar never falls back to mock June events', () => {
  const html = mCalendar({ live: {} });
  assert.doesNotMatch(html, /Wistia Holiday/);
  assert.doesNotMatch(html, /Lunch w\/ Sam/);
});

test('mobile calendar shows an empty state when the agenda has no events', () => {
  const html = mCalendar({ live: { calendar: { month: 'July 2026', week: [], agenda: [] } } });
  assert.match(html, /m-agenda-empty/);
});
