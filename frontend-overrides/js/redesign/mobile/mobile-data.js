// Mobile-only static data (agenda view, quick-capture, More hub).
// Surface data shared with desktop is imported from ../data.js — only the
// mobile-specific shapes live here.

// ---- calendar agenda (phone replaces the month grid with a day-grouped list)
export const WEEK_STRIP = [
  { d: 'M', date: 15 }, { d: 'T', date: 16 }, { d: 'W', date: 17 },
  { d: 'T', date: 18 }, { d: 'F', date: 19, today: true }, { d: 'S', date: 20 }, { d: 'S', date: 21 },
];

export const AGENDA = [
  { label: 'TODAY · FRI JUN 19', tag: 'Juneteenth', tagColor: 'var(--gold)', events: [
    { time: 'all-day', tone: 'var(--gold)', title: 'Wistia Holiday · Office closed', sub: 'Kirill OOO · Mitra OOO' },
    { time: '9:00', tone: 'var(--teal)', title: 'Hold: prep for Senior Mgmt', sub: 'Suggested by __AGENT_NAME__ · 1 hr' },
  ] },
  { label: 'MON · JUN 22', events: [
    { time: '08:15', tone: 'var(--teal)', title: 'Daycare drop-off' },
    { time: '10:30', tone: 'var(--blue)', title: 'Senior Management sync', sub: 'Wistia-wide · 45 min' },
    { time: '12:00', tone: 'var(--violet)', title: 'Lunch w/ Sam' },
  ] },
];

// ---- quick capture --------------------------------------------------------
export const CAPTURE_TYPES = [
  { id: 'remind', glyph: '⏰', label: 'Remind' },
  { id: 'task', glyph: '✓', label: 'Task' },
  { id: 'note', glyph: '✎', label: 'Note' },
  { id: 'research', glyph: '⌕', label: 'Research' },
];
// ---- quick-capture recents (real, localStorage-backed) --------------------
// Task 3.6 (honesty): the sheet used to ship a hardcoded "RECENT CAPTURES"
// list (two mock rows, unchanging) AND a live-looking "Gary parsed: ..."
// preview keyed only off captureType (CAPTURE_PARSE, removed) — neither
// reflected anything the user actually typed or sent. Worse for the preview:
// captureDraft is in app.js's PLAIN_SHEET_FIELDS render-skip set (the sheet
// input handler skips the full re-render so typing doesn't fight the
// textarea's own cursor/IME state), so a "parsed" line keyed off captureDraft
// would visibly NOT update per keystroke — a second, more obvious lie on top
// of the first. Dropped outright rather than fixed: no speculative preview at
// all.
//
// Real recents: the last RECENTS_MAX actual captures (text + chosen type +
// timestamp), written on a SUCCESSFUL sendCapture (mobile-app.js) and read
// back when the sheet opens. Storage functions take `storage` as a plain
// param (same pattern as chat-strip.js's readCollapsed/toggleCollapsed) so
// they're testable without a real localStorage, and never throw.
const RECENTS_KEY = 'gary.recentCaptures';
const RECENTS_MAX = 5;

// Pure: prepend `entry` and cap at RECENTS_MAX. The only impure bits below
// (readRecentCaptures/writeRecentCaptures) are thin storage wrappers around
// this.
export function pushRecentCapture(list, entry) {
  return [entry, ...(Array.isArray(list) ? list : [])].slice(0, RECENTS_MAX);
}

export function readRecentCaptures(storage) {
  try {
    if (!storage) return [];
    const raw = storage.getItem(RECENTS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) { return []; }
}

export function writeRecentCaptures(storage, list) {
  try { if (storage) storage.setItem(RECENTS_KEY, JSON.stringify(list)); } catch (_) {}
}

// Record one successful capture and return the updated (already-persisted)
// list, so the caller can render immediately without a second storage round
// trip.
export function recordCapture(storage, { text, type, ts } = {}) {
  const list = pushRecentCapture(readRecentCaptures(storage), {
    text: String(text || ''), type: String(type || ''), ts: ts || Date.now(),
  });
  writeRecentCaptures(storage, list);
  return list;
}

// Pure: epoch-ms timestamp → short relative label ("now"/"5m"/"2h"/"3d").
// `nowMs` is a real param (not an internal Date.now()) so it's deterministic
// under test — mirrors live/inbox-logic.js's ageLabel, but that takes
// pre-computed hours; this takes raw timestamps since that's what a capture
// record stores.
export function captureAgeLabel(ts, nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  const diffMin = Math.max(0, Math.round((now - (ts || 0)) / 60000));
  if (diffMin < 1) return 'now';
  if (diffMin < 60) return `${diffMin}m`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h`;
  return `${Math.round(diffH / 24)}d`;
}

// ---- More hub -------------------------------------------------------------
// id maps to the desktop surface key where one exists (calendar/research/…/settings)
export const MORE_CARDS = [
  // Counts are computed live in mMore (mobile-surfaces.js moreCount) — never
  // hardcode a stat here; it renders as if it were real data.
  { id: 'calendar', name: 'Calendar', iconBg: 'var(--tealtint)', iconColor: 'var(--teal)', icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>' },
  { id: 'research', name: 'Deep Research', iconBg: 'rgba(169,155,245,.12)', iconColor: 'var(--violet)', icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>' },
  { id: 'library', name: 'Library', iconBg: 'rgba(123,182,255,.12)', iconColor: 'var(--blue)', icon: '<path d="M4 5a2 2 0 0 1 2-2h11l3 3v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 8h7M8 12h7M8 16h4"/>' },
  { id: 'notes', name: 'Notes', iconBg: 'rgba(232,194,104,.12)', iconColor: 'var(--gold)', icon: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  { id: 'scheduled', name: 'Scheduled', iconBg: 'rgba(91,217,127,.12)', iconColor: 'var(--green)', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: 'settings', name: 'Settings', iconBg: '#2a2d34', iconColor: 'var(--mut)', icon: '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>' },
];
