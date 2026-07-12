import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mCalendar } from '../redesign/mobile/mobile-surfaces.js';
import { monthWindow } from '../redesign/live/calendar-logic.js';

const calState = (live) => ({ surface: 'calendar', quick: '', live });

// ---------------------------------------------------------------------------
// Fix round 1, finding 3 (task-w2a-report.md), orchestration half: shiftMonth
// (desktop ‹/›/Today nav) must roll back state.calMonthOffset when its own
// nav attempt fails — it used to bump the offset BEFORE the fetch
// unconditionally, so a failed nav desynced it from what actually loaded
// (the next successful nav would silently jump two months). Exercises the
// real actions.calNext/calPrev through live/index.js's load orchestration —
// same minimal shim set as load-orchestration.test.js/research-poll-honest.
// test.js (calendar.js only needs runtime.js + api.js + index.js +
// calendar-logic.js, none of which touch the DOM).
// ---------------------------------------------------------------------------
globalThis.location = { origin: 'http://localhost' };
const { runtime } = await import('../redesign/live/runtime.js');
const { load: loadCalendar, actions: calActions } = await import('../redesign/live/calendar.js');

function jsonRes(obj) {
  return { ok: true, headers: { get: () => 'application/json' }, json: async () => obj, text: async () => JSON.stringify(obj) };
}
async function until(check, tries = 100) {
  for (let i = 0; i < tries; i++) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 0));
  }
  return false;
}

test('shiftMonth: a failed nav rolls back calMonthOffset and shows a month-specific toast, keeping the last-loaded grid', async () => {
  const state = { live: {}, calMonthOffset: 0 };
  runtime.state = state;
  runtime.actions = {};
  runtime.render = () => {};

  // Seed a successful initial load at offset 0 (bypassing live/index.js's
  // orchestration — this is just test setup, not what's under test here).
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/calendar/calendars')) return jsonRes({ calendars: [] });
    return jsonRes({ events: [] });
  };
  await loadCalendar(state);
  assert.equal(state.calMonthOffset, 0);
  const monthBefore = state.live.calendar.month;
  assert.ok(state.live.calendar.cells.length > 0, 'the seeded grid has cells (any real month always does — 35/42 cells regardless of events)');

  // Now the events fetch fails for the NEXT nav.
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/calendar/calendars')) return jsonRes({ calendars: [] });
    throw new Error('events fetch failed');
  };
  calActions.calNext(); // fire-and-forget, same as a real ‹/› click
  assert.equal(state.calMonthOffset, 1, 'the click bumps the offset immediately (optimistic), before the fetch even resolves');

  const settled = await until(() => state.calMonthOffset === 0);
  assert.ok(settled, 'the failed nav never rolled the offset back');
  assert.equal(state.live.calendar.month, monthBefore, 'the last successfully-loaded month data is untouched (policy 2: populated surface keeps its data)');
  assert.match(state.inboxToast?.msg || '', /Couldn't load/, 'a month-specific toast replaces the generic "Refresh failed" message');

  delete globalThis.fetch;
});

test('shiftMonth: a successful nav commits the new offset (unchanged happy path)', async () => {
  const state = { live: {}, calMonthOffset: 0 };
  runtime.state = state;
  runtime.actions = {};
  runtime.render = () => {};

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/calendar/calendars')) return jsonRes({ calendars: [] });
    return jsonRes({ events: [] });
  };
  await loadCalendar(state);

  calActions.calNext();
  assert.equal(state.calMonthOffset, 1);
  const settled = await until(() => state.retrying?.calendar !== true);
  assert.ok(settled);
  assert.equal(state.calMonthOffset, 1, 'a successful nav keeps the new offset — no rollback');
  assert.equal(state.loadError?.calendar, undefined);

  delete globalThis.fetch;
});

test('desktop calendar toolbar controls are wired', () => {
  const html = renderCenter(calState({ calendar: { cells: [{ date: 1 }], month: 'July 2026' } }));
  assert.match(html, /data-act="calPrev"/);
  assert.match(html, /data-act="calToday"/);
  assert.match(html, /data-act="calNext"/);
});

test('desktop calendar toolbar shows the current month label between the nav buttons', () => {
  const html = renderCenter(calState({ calendar: { cells: [{ date: 1 }], month: 'July 2026' } }));
  const prev = html.indexOf('data-act="calPrev"');
  const month = html.indexOf('class="cal-month"');
  const next = html.indexOf('data-act="calNext"');
  assert.ok(prev > -1 && month > -1 && next > -1, 'all three are present');
  assert.ok(prev < month && month < next, 'the month label sits between ‹ and ›');
  assert.match(html, /class="cal-month">July 2026</);
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

// ---------------------------------------------------------------------------
// Fix round 1, finding 3 (task-w2a-report.md), renderer half: calendarSurface
// used to show the same "Calendar hasn't loaded" copy whether the calendar
// had simply never loaded yet OR a real load/nav had just failed — it never
// read state.loadError.calendar at all. A genuine load failure (nothing to
// show — see live/index.js's populated-surface policy, under which
// loadError.calendar is only ever set when there's truly no data) now gets
// the same shared error partial every other surface uses.
// ---------------------------------------------------------------------------
test('desktop calendar: a real load failure (loadError.calendar set) shows the shared error partial, not the generic "hasn\'t loaded" copy', () => {
  const html = renderCenter({ surface: 'calendar', quick: '', loadError: { calendar: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="calendar"/);
  assert.doesNotMatch(html, /Calendar hasn’t loaded/);
});

test('desktop calendar: no loadError yet (first render, before any load has resolved) keeps the plain "hasn\'t loaded" copy', () => {
  const html = renderCenter(calState({}));
  assert.match(html, /Calendar hasn’t loaded/);
  assert.doesNotMatch(html, /load-error-block/);
});

// ---------------------------------------------------------------------------
// Task 2.4: the quick-add box used to show a hardcoded "__AGENT_NAME__
// parsed: <raw text> · Personal · 1 hr" line the instant you typed anything —
// a fake parse result invented client-side, not the server's actual answer.
// Nothing speculative should render before the server responds.
// ---------------------------------------------------------------------------
test('desktop calendar: the fake "parsed: … Personal · 1 hr" preview is gone', () => {
  const html = renderCenter({ surface: 'calendar', quick: 'lunch with Sam tue 1pm', live: { calendar: { cells: [{ date: 1 }], month: 'July 2026' } } });
  assert.doesNotMatch(html, /parsed:/);
  assert.doesNotMatch(html, /Personal · 1 hr/);
  assert.doesNotMatch(html, /cal-parse/);
});

// ---------------------------------------------------------------------------
// Task 2.4: a successful quick-add briefly highlights the created event
// (keyed by its real uid) in the grid — never a speculative pre-response
// highlight, and never highlighting an unrelated event.
// ---------------------------------------------------------------------------
test('desktop calendar: highlights the cell event matching calHighlightUid', () => {
  const html = renderCenter({
    surface: 'calendar', quick: '',
    calHighlightUid: 'evt-42',
    live: { calendar: { month: 'July 2026', cells: [{ date: 5, events: [{ label: '2:00 Standup', dot: 'red', uid: 'evt-42' }] }] } },
  });
  assert.match(html, /class="ev hl"/);
});

test('desktop calendar: does not highlight events that are not the just-created one', () => {
  const html = renderCenter({
    surface: 'calendar', quick: '',
    calHighlightUid: 'evt-other',
    live: { calendar: { month: 'July 2026', cells: [{ date: 5, events: [{ label: '2:00 Standup', dot: 'red', uid: 'evt-42' }] }] } },
  });
  assert.doesNotMatch(html, /class="ev hl"/);
});

test('desktop calendar: no highlight class at all when nothing was just created', () => {
  const html = renderCenter({
    surface: 'calendar', quick: '',
    live: { calendar: { month: 'July 2026', cells: [{ date: 5, events: [{ label: '2:00 Standup', dot: 'red', uid: 'evt-42' }] }] } },
  });
  assert.doesNotMatch(html, / hl"/);
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

test('mobile calendar: highlights the agenda event matching calHighlightUid', () => {
  const html = mCalendar({
    calHighlightUid: 'evt-42',
    live: { calendar: { month: 'July 2026', week: [], agenda: [{ label: 'TODAY', events: [{ time: '2:00', tone: 'red', title: 'Standup', uid: 'evt-42' }] }] } },
  });
  assert.match(html, /class="det hl"/);
});

test('mobile calendar: does not highlight an unrelated agenda event', () => {
  const html = mCalendar({
    calHighlightUid: 'evt-other',
    live: { calendar: { month: 'July 2026', week: [], agenda: [{ label: 'TODAY', events: [{ time: '2:00', tone: 'red', title: 'Standup', uid: 'evt-42' }] }] } },
  });
  assert.doesNotMatch(html, /class="det hl"/);
});
