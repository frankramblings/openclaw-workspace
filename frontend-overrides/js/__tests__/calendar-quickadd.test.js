// Task 2.4: calendar quick-add honesty — action-level tests for
// live/calendar.js's clearQuick.
//
// Honesty contract: a parse/create failure keeps the typed text in the box
// and raises an error toast (never silently discards what was typed, and
// never shows a fabricated "parsed: …" preview — see the render-level
// coverage in calendar-honest.test.js for that). Only a real success clears
// the input, toasts, and briefly highlights the created event (by its real
// uid) once the reload brings it into the grid/agenda.
//
// Both shells dispatch clearQuick through the exact same data-act — desktop's
// "↵ Add" (surfaces.js) and mobile's "+" (mobile-surfaces.js's mCalendar) —
// so there is one implementation to get right, not two. The last test below
// verifies that wiring directly (Task 2.4's "verify the mobile + path
// dispatches the real calendar action").
import { test, mock } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mCalendar } from '../redesign/mobile/mobile-surfaces.js';

// live/calendar.js is a browser module (fetch/document) — same minimal shim
// set as chat-turn-epoch.test.js / model-sheet-retry.test.js.
globalThis.location = { origin: 'http://localhost' };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
globalThis.document = { querySelector: () => null };

const { runtime } = await import('../redesign/live/runtime.js');
const { actions } = await import('../redesign/live/calendar.js');

const jsonRes = (obj, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  headers: { get: () => 'application/json' },
  json: async () => obj,
  text: async () => JSON.stringify(obj),
});

function wireFetch(router) {
  globalThis.fetch = async (url, opts) => {
    const path = String(url).replace('http://localhost', '');
    const hit = router(path, opts);
    if (hit) return hit;
    // The success path fires a background reload('calendar') that clearQuick
    // never awaits — keep its GETs harmless so it can't pollute assertions.
    if (path.startsWith('/api/calendar/calendars')) return jsonRes({ calendars: [] });
    if (path.startsWith('/api/calendar/events') && (!opts || !opts.method || opts.method === 'GET')) return jsonRes({ events: [] });
    return jsonRes({});
  };
}

function freshState(quick = '') {
  return { quick, live: {} };
}

test('empty/whitespace input: clearQuick just clears the box — no requests, no toast', async () => {
  const state = freshState('   ');
  runtime.state = state;
  runtime.render = () => {};
  let called = false;
  globalThis.fetch = async () => { called = true; return jsonRes({}); };
  try {
    await actions.clearQuick();
    assert.equal(state.quick, '');
    assert.equal(called, false, 'a blank quick-add never hits the network');
    assert.equal(state.inboxToast, undefined);
  } finally {
    delete globalThis.fetch;
  }
});

test('parse request fails outright: typed text survives, error toast shown', async () => {
  const state = freshState('lunch with sam tue 1pm');
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/calendar/quick-parse') throw new Error('network down');
  });
  try {
    await actions.clearQuick();
    assert.equal(state.quick, 'lunch with sam tue 1pm', 'typed text preserved on a parse failure');
    assert.match(state.inboxToast?.msg || '', /couldn.t add/i);
  } finally {
    delete globalThis.fetch;
  }
});

test('parser responds with an error body: treated as a failure, not a silent no-op', async () => {
  const state = freshState('feed krypto 1pm tmrw');
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/calendar/quick-parse') return jsonRes({ error: 'brain unavailable' }, false);
  });
  try {
    await actions.clearQuick();
    assert.equal(state.quick, 'feed krypto 1pm tmrw');
    assert.match(state.inboxToast?.msg || '', /couldn.t add/i);
  } finally {
    delete globalThis.fetch;
  }
});

test('parser returns a shapeless result (no dtstart or summary): failure, text kept', async () => {
  const state = freshState('asdkjhaskjdh');
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/calendar/quick-parse') return jsonRes({});
  });
  try {
    await actions.clearQuick();
    assert.equal(state.quick, 'asdkjhaskjdh');
    assert.match(state.inboxToast?.msg || '', /couldn.t add/i);
  } finally {
    delete globalThis.fetch;
  }
});

test('parse succeeds but the create POST fails: typed text still survives', async () => {
  const state = freshState('lunch with sam tue 1pm');
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/calendar/quick-parse') {
      return jsonRes({ summary: 'Lunch with Sam', dtstart: '2026-07-14T13:00:00-04:00', dtend: '2026-07-14T14:00:00-04:00', all_day: false });
    }
    if (path === '/api/calendar/events') throw new Error('502 during a gateway restart');
  });
  try {
    await actions.clearQuick();
    assert.equal(state.quick, 'lunch with sam tue 1pm', 'a create failure must not lose the typed text either');
    assert.match(state.inboxToast?.msg || '', /couldn.t add/i);
  } finally {
    delete globalThis.fetch;
  }
});

test('success: input clears, toast confirms, and the new event is highlighted by uid — temporarily', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const state = freshState('lunch with sam tue 1pm');
  runtime.state = state;
  runtime.render = () => {};
  wireFetch((path) => {
    if (path === '/api/calendar/quick-parse') {
      return jsonRes({ summary: 'Lunch with Sam', dtstart: '2026-07-14T13:00:00-04:00', dtend: '2026-07-14T14:00:00-04:00', all_day: false });
    }
    if (path === '/api/calendar/events') return jsonRes({ summary: 'Lunch with Sam', uid: 'evt-99' });
  });
  try {
    await actions.clearQuick();
    assert.equal(state.quick, '', 'input cleared only on real success');
    assert.match(state.inboxToast?.msg || '', /Lunch with Sam/);
    assert.equal(state.calHighlightUid, 'evt-99', 'the created event is marked for a highlight by its real uid');

    mock.timers.tick(5000);
    assert.equal(state.calHighlightUid, null, 'the highlight is temporary, not permanent state');
  } finally {
    delete globalThis.fetch;
    mock.timers.reset();
  }
});

// ---------------------------------------------------------------------------
// Task 2.4: "verify the mobile + path dispatches the real calendar action" —
// both shells wire the identical data-act, so there is exactly one clearQuick
// implementation (live/calendar.js's) backing both, not a separate/stale
// mobile-only handler.
// ---------------------------------------------------------------------------
test('mobile "+" and desktop "↵ Add" dispatch the SAME action — clearQuick', () => {
  const desktopHtml = renderCenter({ surface: 'calendar', quick: 'x', live: { calendar: { cells: [{ date: 1 }], month: 'July 2026' } } });
  const mobileHtml = mCalendar({ quick: 'x', live: { calendar: { month: 'July 2026', week: [], agenda: [] } } });
  const desktopAct = desktopHtml.match(/class="cal-add" data-act="([^"]+)"/);
  const mobileAct = mobileHtml.match(/class="add" data-act="([^"]+)"/);
  assert.ok(desktopAct, 'desktop Add button present');
  assert.ok(mobileAct, 'mobile + button present');
  assert.equal(desktopAct[1], 'clearQuick');
  assert.equal(mobileAct[1], 'clearQuick');
  assert.equal(desktopAct[1], mobileAct[1]);
});
