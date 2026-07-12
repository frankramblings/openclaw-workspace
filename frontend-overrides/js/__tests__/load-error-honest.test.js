// Task 2.1: failure state ≠ empty state. A surface whose live load() threw
// must show "Couldn't load X — Retry", never the happy empty/celebration
// copy that a legitimately-empty result gets. Covers inbox/email/calendar on
// both shells (notes/library/research are desktop-only renderers — mobile's
// "More" hub pushes through the same renderCenter, see mobile-app.js
// pushedSurface, so fixing surfaces.js covers both shells for those three).
import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter } from '../redesign/surfaces.js';
import { mInbox, mEmailList, mCalendar } from '../redesign/mobile/mobile-surfaces.js';

// ---------------------------------------------------------------------------
// INBOX
// ---------------------------------------------------------------------------
test('desktop inbox: loadError shows the error partial, not "Inbox zero"', () => {
  const html = renderCenter({ surface: 'inbox', dismissed: [], loadError: { inbox: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="inbox"/);
  assert.doesNotMatch(html, /Inbox zero/);
});

test('desktop inbox: a real empty result still shows "Inbox zero"', () => {
  const html = renderCenter({ surface: 'inbox', dismissed: [], live: { inbox: { items: [] } } });
  assert.match(html, /Inbox zero/);
  assert.doesNotMatch(html, /load-error-block/);
});

test('mobile inbox: loadError shows the error partial, not "Inbox zero"', () => {
  const html = mInbox({ surface: 'inbox', dismissed: [], loadError: { inbox: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="inbox"/);
  assert.doesNotMatch(html, /Inbox zero/);
});

test('mobile inbox: a real empty result still shows "Inbox zero"', () => {
  const html = mInbox({ surface: 'inbox', dismissed: [], live: { inbox: { items: [] } } });
  assert.match(html, /Inbox zero/);
  assert.doesNotMatch(html, /load-error-block/);
});

// ---------------------------------------------------------------------------
// EMAIL
// ---------------------------------------------------------------------------
test('desktop email: loadError shows the error partial, not "No email to show yet"', () => {
  const html = renderCenter({ surface: 'email', selEmail: 0, emailQuery: '', loadError: { email: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="email"/);
  assert.doesNotMatch(html, /No email to show yet/);
});

test('desktop email: a real empty inbox still shows the honest empty reader', () => {
  const html = renderCenter({ surface: 'email', selEmail: 0, emailQuery: '', live: { email: { emails: [] } } });
  assert.match(html, /reader-empty/);
  assert.match(html, /No email to show yet/);
  assert.doesNotMatch(html, /load-error-block/);
});

test('mobile email: loadError shows the error partial, not "No mail here yet"', () => {
  const html = mEmailList({ selEmail: 0, emailQuery: '', loadError: { email: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="email"/);
  assert.doesNotMatch(html, /No mail here yet/);
});

test('mobile email: a real empty inbox still shows "No mail here yet"', () => {
  const html = mEmailList({ selEmail: 0, emailQuery: '', live: { email: { emails: [] } } });
  assert.match(html, /No mail here yet/);
  assert.doesNotMatch(html, /load-error-block/);
});

// ---------------------------------------------------------------------------
// CALENDAR
// ---------------------------------------------------------------------------
test('desktop calendar: keeps its honest empty copy but gains a Retry button', () => {
  const html = renderCenter({ surface: 'calendar', quick: '', live: {} });
  assert.match(html, /cal-empty/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="calendar"/);
});

test('mobile calendar: loadError shows the error partial, not "No events in the next 7 days"', () => {
  const html = mCalendar({ loadError: { calendar: 'fetch failed' }, live: { calendar: { month: 'July 2026', week: [], agenda: [] } } });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="calendar"/);
  assert.doesNotMatch(html, /No events in the next 7 days/);
});

test('mobile calendar: a real empty week still shows "No events in the next 7 days"', () => {
  const html = mCalendar({ live: { calendar: { month: 'July 2026', week: [], agenda: [] } } });
  assert.match(html, /No events in the next 7 days/);
  assert.doesNotMatch(html, /load-error-block/);
});

// ---------------------------------------------------------------------------
// RESEARCH / LIBRARY / NOTES (desktop renderer; mobile "More" reuses it via
// mobile-app.js's pushedSurface, so no separate mobile assertions needed)
// ---------------------------------------------------------------------------
test('research: loadError shows the error partial', () => {
  const html = renderCenter({
    surface: 'research', researchQuery: '', research: 'idle', resOpenCtl: null,
    resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' },
    loadError: { research: 'fetch failed' }, live: {},
  });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="research"/);
});

test('library: loadError shows the error partial', () => {
  const html = renderCenter({ surface: 'library', libFilter: 'all', libQuery: '', loadError: { library: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="library"/);
});

test('notes: loadError shows the error partial instead of the (blank) editor', () => {
  const html = renderCenter({ surface: 'notes', selDoc: 0, notesFilter: '', loadError: { notes: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
  assert.match(html, /data-act="retrySurface"/);
  assert.match(html, /data-arg="notes"/);
});
