// Task 2.1: failure state ≠ empty state. A surface whose live load() threw
// must show "Couldn't load X — Retry", never the happy empty/celebration
// copy that a legitimately-empty result gets. Covers inbox/email/calendar on
// both shells (notes/library/research are desktop-only renderers — mobile's
// "More" hub pushes through the same renderCenter, see mobile-app.js
// pushedSurface, so fixing surfaces.js covers both shells for those three).
import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter, inboxToastHtml } from '../redesign/surfaces.js';
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

// ---------------------------------------------------------------------------
// Fix round 1, finding 2 (task-w2a-report.md): POLICY CHANGE — a populated
// surface must survive a transient refresh failure. live/index.js's load
// orchestration now never sets state.loadError for a surface that already
// has displayable data (see load-orchestration.test.js for that decision
// itself); it sets a toast instead and leaves the data alone. These are the
// renderer-level half of that contract: given the state shape the fixed
// orchestrator actually produces (data present, loadError absent, toast
// set), the reader/list/grid must still render and the error partial must
// never appear — this is what used to "nuke" the email reader and the
// library grid on any background refresh hiccup. Covers both shells ×
// email/library at minimum (library has no separate mobile renderer —
// mobile's "More" hub reuses renderCenter directly, same as the loadError
// coverage above).
// ---------------------------------------------------------------------------
test('desktop email: a populated reader survives a failed background refresh (no loadError set) and the toast still shows', () => {
  const s = {
    surface: 'email', selEmail: 0, emailQuery: '',
    live: { email: { emails: [{ subj: 'Hi', from: 'a@b.com', time: '1:00', srcColor: '', srcBg: '' }] } },
    inboxToast: { msg: 'Refresh failed — showing cached data', undoTs: null },
  };
  const html = renderCenter(s);
  assert.doesNotMatch(html, /load-error-block/, 'a populated surface must never show the error partial for a background refresh failure');
  assert.match(html, /class="reader"/, 'the existing reader must still render');
  assert.match(inboxToastHtml(s), /Refresh failed/, 'the transient notice must be visible (shell-level toast)');
});

test('mobile email: a populated list survives a failed background refresh (no loadError set) and the toast still shows', () => {
  const s = {
    selEmail: 0, emailQuery: '',
    live: { email: { emails: [{ subj: 'Hi', from: 'a@b.com', time: '1:00', srcColor: '', srcBg: '' }] } },
    inboxToast: { msg: 'Refresh failed — showing cached data', undoTs: null },
  };
  const html = mEmailList(s);
  assert.doesNotMatch(html, /load-error-block/);
  assert.match(html, /m-mail-list/);
  assert.match(html, />Hi</, 'the existing email row must still render');
  assert.match(html, /Refresh failed/, 'mEmailList now carries the shared inline toast (mToastHtml), same as mInbox');
});

test('desktop library: a populated grid survives a failed background refresh (no loadError set) and the toast still shows', () => {
  const s = {
    surface: 'library', libFilter: 'all', libQuery: '',
    live: { library: { items: [{ title: 'Doc A', kind: 'DOC', kindLabel: 'DOCUMENT', when: '1h', cat: 'doc' }] } },
    inboxToast: { msg: 'Refresh failed — showing cached data', undoTs: null },
  };
  const html = renderCenter(s);
  assert.doesNotMatch(html, /load-error-block/, 'a populated surface must never show the error partial for a background refresh failure');
  assert.match(html, /Doc A/, 'the existing library grid must still render');
  assert.match(inboxToastHtml(s), /Refresh failed/);
});

test('empty + failure (no prior data) still shows the honest error partial — unchanged by the policy change', () => {
  // Sanity check that the existing empty+loadError tests above still hold:
  // the toast/keep-data path only applies when there IS something to keep.
  const html = renderCenter({ surface: 'email', selEmail: 0, emailQuery: '', loadError: { email: 'fetch failed' }, live: {} });
  assert.match(html, /load-error-block/);
});

// ---------------------------------------------------------------------------
// Fix round 1, finding 5: the Retry button reflects state.retrying[surface]
// (set by live/index.js while a (re)load for that surface is in flight) —
// disabled, with a spinner label, instead of a second clickable "Retry" a
// user could tap again before the first attempt even resolves.
// ---------------------------------------------------------------------------
test('desktop: the Retry button disables and shows a spinner while state.retrying[surface] is set', () => {
  const idle = renderCenter({ surface: 'library', libFilter: 'all', libQuery: '', loadError: { library: 'fetch failed' }, live: {} });
  assert.doesNotMatch(idle, /disabled/);
  assert.match(idle, />Retry</);

  const busy = renderCenter({ surface: 'library', libFilter: 'all', libQuery: '', loadError: { library: 'fetch failed' }, retrying: { library: true }, live: {} });
  assert.match(busy, /data-act="retrySurface"[^>]*disabled/);
  assert.match(busy, /Retrying…/);
});

test('mobile: the Retry button disables and shows a spinner while state.retrying[surface] is set', () => {
  const idle = mEmailList({ selEmail: 0, emailQuery: '', loadError: { email: 'fetch failed' }, live: {} });
  assert.doesNotMatch(idle, /disabled/);

  const busy = mEmailList({ selEmail: 0, emailQuery: '', loadError: { email: 'fetch failed' }, retrying: { email: true }, live: {} });
  assert.match(busy, /data-act="retrySurface"[^>]*disabled/);
  assert.match(busy, /Retrying…/);
});
