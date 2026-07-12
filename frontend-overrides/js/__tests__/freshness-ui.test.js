// Task W6 — 6.1 (desktop refresh buttons, mobile PTR is covered by
// mobile-pushed-toast.test.js) + 6.2 (hard-cap disclosure footer).
import { test } from 'node:test';
import assert from 'node:assert';
import { renderCenter, capNotice, INBOX_CAP, EMAIL_CAP } from '../redesign/surfaces.js';
import { mInbox, mEmailList } from '../redesign/mobile/mobile-surfaces.js';

// The live/*.js modules all eventually import api.js, which reads
// location.origin at module top level — dynamic import AFTER the stub is in
// place, same pattern as load-orchestration.test.js / mobile-pushed-toast.
// test.js, so these CAN be pulled in even though surfaces.js's own
// (hand-mirrored, see the comment there) INBOX_CAP/EMAIL_CAP cannot.
globalThis.location = { origin: 'http://localhost' };
const { CAP: LIVE_INBOX_CAP } = await import('../redesign/live/inbox.js');
const { CAP: LIVE_EMAIL_CAP } = await import('../redesign/live/email.js');
const { CAP: LIVE_LIBRARY_CAP } = await import('../redesign/live/library.js');
const { CAP: LIVE_RESEARCH_CAP } = await import('../redesign/live/research.js');

// surfaces.js can't statically import the live/*.js modules (every one of
// them eventually imports api.js, which reads `location.origin` at module
// top level — surfaces.js is a pure renderer that several tests import
// before `location` exists). Its INBOX_CAP/EMAIL_CAP (and the un-exported
// LIBRARY_CAP/RESEARCH_CAP) are hand-mirrored instead; this test is the
// tripwire that catches the two ever drifting apart.
test('surfaces.js cap constants stay in sync with each live module\'s own CAP', () => {
  assert.equal(INBOX_CAP, LIVE_INBOX_CAP);
  assert.equal(EMAIL_CAP, LIVE_EMAIL_CAP);
  // library/research CAP isn't exported from surfaces.js, exercised indirectly below.
  assert.equal(LIVE_LIBRARY_CAP, 30);
  assert.equal(LIVE_RESEARCH_CAP, 20);
});

test('capNotice: renders the disclosure line only when length === cap', () => {
  assert.equal(capNotice(199, 200), '');
  assert.match(capNotice(200, 200), /Showing first 200 — refine to see more/);
  assert.equal(capNotice(0, 200), '');
});

// ---------------------------------------------------------------------------
// 6.1: desktop refresh buttons — inbox/email/notes/library headers, reusing
// the same retrySurface plumbing as the error-state Retry button.
// ---------------------------------------------------------------------------

test('desktop inbox header has a refresh button wired to retrySurface', () => {
  const html = renderCenter({ surface: 'inbox', dismissed: [], live: { inbox: { items: [] } } });
  assert.match(html, /data-act="retrySurface" data-arg="inbox"/);
});

test('desktop email header has a refresh button wired to retrySurface', () => {
  const html = renderCenter({ surface: 'email', selEmail: 0, emailQuery: '', live: { email: { emails: [] } } });
  assert.match(html, /data-act="retrySurface" data-arg="email"/);
});

test('desktop library header has a refresh button wired to retrySurface', () => {
  const html = renderCenter({ surface: 'library', libFilter: 'all', libQuery: '', live: { library: { items: [] } } });
  assert.match(html, /data-act="retrySurface" data-arg="library"/);
});

test('desktop notes header has a refresh button wired to retrySurface', () => {
  const html = renderCenter({ surface: 'notes', selDoc: 0, notesFilter: '', live: { notes: { docs: [] } } });
  assert.match(html, /data-act="retrySurface" data-arg="notes"/);
});

test('refresh button reflects state.retrying with a disabled spinner, same as the error-state Retry button', () => {
  const html = renderCenter({ surface: 'inbox', dismissed: [], retrying: { inbox: true }, live: { inbox: { items: [] } } });
  const m = html.match(/<button[^>]*data-act="retrySurface" data-arg="inbox"[^>]*>/);
  assert.ok(m, 'refresh button present');
  assert.match(m[0], /disabled/);
});

// ---------------------------------------------------------------------------
// 6.2: hard-cap disclosure — email/inbox/library/research, both shells.
// ---------------------------------------------------------------------------

const inboxItem = (i) => ({
  id: String(i), source: 'gmail', group: 'needs', src: 'GMAIL', srcColor: '#fff', srcBg: '#333',
  who: `Person ${i}`, time: 'now', body: 'hello', actions: [], rec: null, meta: {},
  primary: 'Open', secondary: 'Mark read', suggest: 'Archive', unread: false,
});
const emailItem = (i) => ({
  subj: `Subject ${i}`, from: `Person ${i}`, time: 'now', src: 'GMAIL', srcColor: '#fff', srcBg: '#333', unread: false,
});
const libItem = (i) => ({
  id: String(i), title: `Doc ${i}`, kind: 'DOC', kindLabel: 'DOCUMENT', cat: 'doc', when: 'now',
});
const pastResearch = (i) => ({ q: `question ${i}`, m: '5m · 3 sources', rid: `r${i}` });

test('desktop inbox: no cap notice below the cap', () => {
  const items = Array.from({ length: INBOX_CAP - 1 }, (_, i) => inboxItem(i));
  const html = renderCenter({ surface: 'inbox', dismissed: [], live: { inbox: { items } } });
  assert.doesNotMatch(html, /refine to see more/);
});

test('desktop inbox: "showing first N" footer when the list lands exactly at the cap', () => {
  const items = Array.from({ length: INBOX_CAP }, (_, i) => inboxItem(i));
  const html = renderCenter({ surface: 'inbox', dismissed: [], live: { inbox: { items } } });
  assert.match(html, new RegExp(`Showing first ${INBOX_CAP} — refine to see more`));
});

test('mobile inbox: "showing first N" footer when the list lands exactly at the cap', () => {
  const items = Array.from({ length: INBOX_CAP }, (_, i) => inboxItem(i));
  const html = mInbox({ dismissed: [], live: { inbox: { items } } });
  assert.match(html, new RegExp(`Showing first ${INBOX_CAP} — refine to see more`));
});

test('desktop email: "showing first N" footer when the list lands exactly at the cap', () => {
  const emails = Array.from({ length: EMAIL_CAP }, (_, i) => emailItem(i));
  const html = renderCenter({ surface: 'email', selEmail: 0, emailQuery: '', live: { email: { emails } } });
  assert.match(html, new RegExp(`Showing first ${EMAIL_CAP} — refine to see more`));
});

test('mobile email: "showing first N" footer when the list lands exactly at the cap', () => {
  const emails = Array.from({ length: EMAIL_CAP }, (_, i) => emailItem(i));
  const html = mEmailList({ emailQuery: '', selEmail: 0, live: { email: { emails } } });
  assert.match(html, new RegExp(`Showing first ${EMAIL_CAP} — refine to see more`));
});

test('desktop email: no footer below the cap', () => {
  const emails = Array.from({ length: EMAIL_CAP - 1 }, (_, i) => emailItem(i));
  const html = renderCenter({ surface: 'email', selEmail: 0, emailQuery: '', live: { email: { emails } } });
  assert.doesNotMatch(html, /refine to see more/);
});

test('desktop library: "showing first N" footer when the RAW list (pre-filter) lands exactly at the cap', () => {
  const items = Array.from({ length: LIVE_LIBRARY_CAP }, (_, i) => libItem(i));
  const html = renderCenter({ surface: 'library', libFilter: 'all', libQuery: '', live: { library: { items } } });
  assert.match(html, new RegExp(`Showing first ${LIVE_LIBRARY_CAP} — refine to see more`));
});

test('desktop research: "showing first N" footer when past-runs lands exactly at the cap', () => {
  const past = Array.from({ length: LIVE_RESEARCH_CAP }, (_, i) => pastResearch(i));
  const html = renderCenter({
    surface: 'research', researchQuery: '', resOpenCtl: null,
    resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' },
    live: { research: { past } },
  });
  assert.match(html, new RegExp(`Showing first ${LIVE_RESEARCH_CAP} — refine to see more`));
});

test('desktop research: no footer below the cap', () => {
  const past = Array.from({ length: LIVE_RESEARCH_CAP - 1 }, (_, i) => pastResearch(i));
  const html = renderCenter({
    surface: 'research', researchQuery: '', resOpenCtl: null,
    resCfg: { rounds: 'Auto', engine: 'Default', endpoint: 'Claude-Cli', model: 'opus-4' },
    live: { research: { past } },
  });
  assert.doesNotMatch(html, /refine to see more/);
});

test('a load error suppresses the cap notice (nothing to disclose when the fetch failed)', () => {
  const items = Array.from({ length: INBOX_CAP }, (_, i) => inboxItem(i));
  const html = renderCenter({ surface: 'inbox', dismissed: [], loadError: { inbox: 'x' }, live: { inbox: { items } } });
  assert.doesNotMatch(html, /refine to see more/);
});
