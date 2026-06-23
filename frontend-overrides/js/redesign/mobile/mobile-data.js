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
    { time: '9:00', tone: 'var(--teal)', title: 'Hold: prep for Senior Mgmt', sub: 'Suggested by Gary · 1 hr' },
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
// live NL parse preview keyed by capture type (mirrors Calendar quick-add)
export const CAPTURE_PARSE = {
  remind: 'Reminder · Fri 9:00 AM',
  task: 'Task · no due date',
  note: 'Note · notes/quick.md',
  research: 'Research · queued',
};
export const RECENT_CAPTURES = [
  { glyph: '✓', color: 'var(--green)', text: "Book Sea Dogs tickets for Father's Day", type: 'Task' },
  { glyph: '⌕', color: 'var(--violet)', text: 'Compare podcast hosting platforms', type: 'Research' },
];

// ---- More hub -------------------------------------------------------------
// id maps to the desktop surface key where one exists (calendar/research/…/settings)
export const MORE_CARDS = [
  { id: 'calendar', name: 'Calendar', count: '3 events today', iconBg: 'var(--tealtint)', iconColor: 'var(--teal)', icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>' },
  { id: 'research', name: 'Deep Research', count: '7 reports', iconBg: 'rgba(169,155,245,.12)', iconColor: 'var(--violet)', icon: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/>' },
  { id: 'library', name: 'Library', count: '24 artifacts', iconBg: 'rgba(123,182,255,.12)', iconColor: 'var(--blue)', icon: '<path d="M4 5a2 2 0 0 1 2-2h11l3 3v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/><path d="M8 8h7M8 12h7M8 16h4"/>' },
  { id: 'notes', name: 'Notes', count: '41 in vault', iconBg: 'rgba(232,194,104,.12)', iconColor: 'var(--gold)', icon: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>' },
  { id: 'scheduled', name: 'Scheduled', count: '5 jobs', iconBg: 'rgba(91,217,127,.12)', iconColor: 'var(--green)', icon: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>' },
  { id: 'settings', name: 'Settings', count: '14 sections', iconBg: '#2a2d34', iconColor: 'var(--mut)', icon: '<path d="M4 8h10M18 8h2M4 16h2M10 16h10"/><circle cx="16" cy="8" r="2.2"/><circle cx="8" cy="16" r="2.2"/>' },
];
