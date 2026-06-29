// Static mock data for the redesign prototype, ported from the design reference.
// In production these become live fetches (sessions, inbox connectors, IMAP,
// CalDAV, research runs, library, notes vault, config, workspace file tree).

export const AVATAR = '/static/redesign-assets/gary-outline.png';

// ---- chat slash commands --------------------------------------------------
export const SLASH_COMMANDS = [
  { glyph: '⚡', name: '/run', desc: 'shell command in the Terminal', color: 'var(--gold)' },
  { glyph: '⌕', name: '/research', desc: 'multi-step web research', color: 'var(--violet)' },
  { glyph: '▤', name: '/split', desc: 'open a surface beside chat', color: 'var(--teal)' },
  { glyph: '✎', name: '/note', desc: 'capture a note to the vault', color: 'var(--green)' },
];

// ---- adaptive agent dock content (per non-chat surface) -------------------
export const DOCK = {
  email:    { sub: 'on this thread', msg: "Three Cannes agreements are live — Tameka and Jayde signed, Brendan's still in revision.", c1: 'Draft a status reply', c2: 'Open all 3' },
  inbox:    { sub: 'triage assistant', msg: '3 items need you — two Slack threads from Cierra and a calendar invite. The rest I can archive.', c1: '✦ Archive the FYI batch', c2: 'Draft replies' },
  calendar: { sub: 'Fri, Jun 19', msg: "You're clear today. Monday is dense — want me to hold 9–10 AM for prep?", c1: 'Hold 9–10 AM', c2: 'Show Monday' },
  research: { sub: 'research agent', msg: 'Queue a question and I run multi-round web research, cite sources, and build a report.', c1: 'Resume last run', c2: 'Open Library' },
  library:  { sub: 'librarian', msg: '24 artifacts saved. I can turn any research run into a visual report, or bundle these into a doc.', c1: 'Make a visual report', c2: 'Clean up duplicates' },
  notes:    { sub: 'on this note', msg: 'This is your live "OpenClaw Redesign" doc. Want me to fold in the latest decisions from chat?', c1: 'Summarize changes', c2: 'Append from chat' },
};

// ---- research controls ----------------------------------------------------
export const RESEARCH_CONTROLS = [
  { key: 'rounds', label: 'Rounds', opts: ['Auto', '1', '2', '3', '5'] },
  { key: 'engine', label: 'Engine', opts: ['Default', 'Fast', 'Thorough'] },
  { key: 'endpoint', label: 'Endpoint', opts: ['Claude-Cli', 'API', 'Local'] },
  { key: 'model', label: 'Model', opts: ['opus-4', 'sonnet-4', 'haiku-4'] },
];
export const RESEARCH_SCOPES = ['Auto', 'Product', 'Compare', 'How-to', 'Fact-check'];
export const PAST_RESEARCH = [
  { q: "Standup comedy that's funny, innovative, can be weird…", m: '2:27 · 4 sources' },
  { q: 'Discussion guide for the film “District 9”', m: '4:18 · 27 sources' },
];

// ---- library --------------------------------------------------------------
export const LIBRARY = [
  { title: 'Podcast hosting platforms — comparison', kind: 'REPORT', kindLabel: 'VISUAL REPORT', when: 'just now', cat: 'report' },
  { title: 'Standup comedy: funny, innovative, weird', kind: 'REPORT', kindLabel: 'VISUAL REPORT', when: '2d', cat: 'report' },
  { title: 'Discussion guide — “District 9”', kind: 'DOC', kindLabel: 'DOCUMENT', when: '3d', cat: 'doc' },
  { title: 'OpenClaw punny name candidates', kind: 'NOTE', kindLabel: 'NOTE', when: '4d', cat: 'note' },
  { title: 'ActivityTree streaming architecture', kind: 'CODE', kindLabel: 'SNIPPET', when: '5d', cat: 'code' },
  { title: 'Q3 content slate — draft outline', kind: 'DOC', kindLabel: 'DOCUMENT', when: '1w', cat: 'doc' },
];
export const KIND_STYLE = {
  REPORT: { kindColor: 'var(--teal)', thumbBg: 'linear-gradient(135deg,rgba(79,227,209,.14),rgba(79,227,209,.03))', tagBg: 'rgba(79,227,209,.12)' },
  DOC:    { kindColor: 'var(--blue)', thumbBg: 'linear-gradient(135deg,rgba(123,182,255,.14),rgba(123,182,255,.03))', tagBg: 'rgba(123,182,255,.12)' },
  NOTE:   { kindColor: 'var(--gold)', thumbBg: 'linear-gradient(135deg,rgba(232,194,104,.14),rgba(232,194,104,.03))', tagBg: 'rgba(232,194,104,.12)' },
  CODE:   { kindColor: 'var(--violet)', thumbBg: 'linear-gradient(135deg,rgba(169,155,245,.14),rgba(169,155,245,.03))', tagBg: 'rgba(169,155,245,.12)' },
};
export const LIB_FILTERS = [['all', 'All'], ['report', 'Reports'], ['doc', 'Docs'], ['note', 'Notes']];

// ---- notes ----------------------------------------------------------------
const P = (text) => ({ t: 'p', text });
const H = (text) => ({ t: 'h', text });
const Q = (text) => ({ t: 'quote', text });
const L = (items) => ({ t: 'list', items });
export const NOTES = [
  { title: 'OpenClaw Redesign — Decisions', path: 'notes/openclaw-redesign.md', version: 7, meta: 'Updated just now · 1,240 words',
    blocks: [
      P('Living doc for the workspace redesign. Direction A — refined charcoal — is the agreed base.'),
      H('Locked decisions'),
      L(['Persistent panes over floating windows', 'Split typography: prose proportional, code/data mono', 'Adaptive companion: Terminal with chat, __AGENT_NAME__ elsewhere']),
      Q('Research controls: sensible defaults, overridable per-search.'),
    ] },
  { title: 'Cannes agreements — status', path: 'notes/cannes-status.md', version: 3, meta: 'Updated 1d ago · 320 words',
    blocks: [P('Tameka ✓ · Jayde ✓ · Brendan — in revision (section 3).')] },
  { title: 'Q3 content slate', path: 'notes/q3-slate.md', version: 12, meta: 'Updated 2d ago · 2,100 words',
    blocks: [P('Draft outline for the Q3 editorial calendar.')] },
  { title: 'Daily standup log', path: 'notes/standup.md', version: 54, meta: 'Updated 2d ago · 5,800 words',
    blocks: [P('Rolling log of daily standups.')] },
];

// ---- workspace file tree --------------------------------------------------
export const FS = [
  { n: 'data', t: 'dir', children: [
    { n: 'skills', t: 'dir', meta: '3', children: [{ n: 'email-triage.md', t: 'md' }, { n: 'cannes-deck.md', t: 'md' }, { n: 'standup.md', t: 'md' }] },
    { n: 'memory.json', t: 'json' },
    { n: 'gary.db', t: 'db' },
  ] },
  { n: 'documents', t: 'dir', children: [{ n: 'openclaw-redesign.md', t: 'md' }, { n: 'q3-slate.md', t: 'md' }] },
  { n: 'notes', t: 'dir', children: [{ n: 'standup.md', t: 'md' }, { n: 'cannes-status.md', t: 'md' }] },
  { n: 'research', t: 'dir', children: [{ n: 'podcast-hosting.md', t: 'md' }] },
  { n: '.env', t: 'env' },
  { n: 'README.md', t: 'md' },
];
export const EXT_COLOR = { md: 'var(--blue)', json: 'var(--gold)', db: 'var(--violet)', env: 'var(--faint)' };

// ---- email ----------------------------------------------------------------
export const EMAILS = [
  { src: 'GMAIL', srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)', subj: 'Re: Demo Meeting: Heike + Wistia', from: 'Micaela Crosta', fromMail: 'micaela@wishlygroup.ca', initials: 'MC', avBg: '#3a2f47', avFg: '#c9b6ff', to: 'Frank, April', time: '04:12 PM', unread: false, attach: [{ name: 'Onboarding Form.pdf', size: '128 KB' }], body: ['Amazing!', 'Adding @April on our team who supports Heike with all her content deliverables.', "She'll send our onboarding form and support with scheduling a kick-off call.", 'Thanks, Mica'] },
  { src: 'GMAIL', srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)', subj: 'Re: Wistia x Jayde x Cannes Agreement', from: 'Tiff Knighten', fromMail: 'tiff@knighten.co', initials: 'TK', avBg: '#2f3a47', avFg: '#9cc7ff', to: 'Frank', time: '10:24 AM', unread: true, attach: [{ name: 'Wistia x Jayde Agreement.pdf', size: '2.4 MB' }], body: ['Hi Frank,', 'Signed agreement attached — all set on our end for Jayde. Let me know if you need anything else before Cannes.', 'Best, Tiff'] },
  { src: 'FB', srcColor: 'var(--blue)', srcBg: 'rgba(123,182,255,.12)', subj: 'About Sophie and others: 107 updates', from: 'Facebook', fromMail: 'notification@facebookmail.com', initials: 'f', avBg: '#243044', avFg: '#7bb6ff', to: 'Frank', time: '09:44 PM', unread: false, body: ['You have 107 new notifications from people you may know this week.'] },
  { src: 'ASANA', srcColor: 'var(--gold)', srcBg: 'rgba(232,194,104,.12)', subj: 'You have 2 overdue tasks', from: 'Asana', fromMail: 'no-reply@asana.com', initials: 'A', avBg: '#3a3326', avFg: '#e8c268', to: 'Frank', time: '09:11 AM', unread: false, body: ['2 tasks are past their due date: send the Cannes deck to legal; confirm ERG breakfast headcount.'] },
];

// ---- inbox triage ---------------------------------------------------------
export const INBOX = [
  { id: 0, group: 'needs', src: 'SLACK', srcColor: 'var(--green)', srcBg: 'rgba(91,217,127,.12)', who: 'Cierra Lyons · @clyons', time: '2d', unread: true, body: 'we have a part 2 for next week if you want to join — went over her use case, recording tool for the podcast.', primary: 'Reply', secondary: 'Mark read' },
  { id: 1, group: 'needs', src: 'SLACK', srcColor: 'var(--green)', srcBg: 'rgba(91,217,127,.12)', who: 'Sasha Friedman', time: '2d', unread: true, body: 'Hi @Frank and @Mitra — thanks again for meeting yesterday! Sharing a doc with the next steps we discussed.', primary: 'Open doc', secondary: 'Mark read' },
  { id: 2, group: 'needs', src: 'GMAIL', srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)', who: 'Sydney Rutman', time: '34h', unread: false, body: 'Updated invitation: Story Leads x Channel Owners @ Tue Jun 23, 3pm–4pm (EDT)', primary: 'Respond', secondary: 'Add to calendar' },
  { id: 3, group: 'fyi', src: 'GMAIL', srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)', who: 'Tropic', time: '37h', aiArchive: true, body: '[Action Required] Reminder! Time to start the renewal for Hootsuite', suggest: 'Archive — newsletter / notification sender' },
  { id: 4, group: 'fyi', src: 'GMAIL', srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)', who: 'Dhruv Pandya', time: '38h', aiArchive: true, body: 'Accepted: #donutfriends Donut @ Thu Jun 18, 5:30pm–6pm (EDT)', suggest: 'Archive — calendar auto-notification' },
  { id: 5, group: 'fyi', src: 'ASANA', srcColor: 'var(--gold)', srcBg: 'rgba(232,194,104,.12)', who: 'Asana', time: '2d', aiArchive: true, body: 'You have unread notifications and 2 overdue tasks.', suggest: 'Archive — recurring digest' },
];

// ---- calendar grid (35 cells: Jun 2026, Mon-start, today = 19) ------------
// Each cell: { date, dim?, today?, last? (no right border), bars:[{label,tone}], events:[{label,dot}], more? }
export const CAL_MONTH = 'June 2026';
export const CAL_CELLS = [
  { date: 1, events: [{ label: 'Barry OOO', dot: 'var(--green)' }] },
  { date: 2, bars: [{ label: 'NYC Tech Week', tone: 'blue' }] },
  { date: 3, bars: [{ label: '', tone: 'blue' }], events: [{ label: '10:30 All Hands', dot: 'var(--blue)' }] },
  { date: 4, bars: [{ label: '', tone: 'blue' }], more: '+6 more' },
  { date: 5, bars: [{ label: 'OOO', tone: 'green' }] },
  { date: 6, events: [{ label: 'NH Maker Fest', dot: 'var(--teal)' }] },
  { date: 7, last: true, events: [{ label: 'Sunday Mass', dot: 'var(--gold)' }] },

  { date: 8, events: [{ label: 'Allie OOO', dot: 'var(--green)' }] },
  { date: 9, bars: [{ label: '2026 Offsite', tone: 'green' }] },
  { date: 10, bars: [{ label: '', tone: 'green' }], events: [{ label: 'Amtrak Group', dot: 'var(--violet)' }] },
  { date: 11, bars: [{ label: '', tone: 'green' }], events: [{ label: 'Headshots', dot: 'var(--violet)' }] },
  { date: 12, events: [{ label: 'ERG Breakfast', dot: 'var(--blue)' }] },
  { date: 13, events: [{ label: 'PlayZone Walk', dot: 'var(--teal)' }] },
  { date: 14, last: true, events: [{ label: 'Flag Day', dot: 'var(--gold)' }] },

  { date: 15, events: [{ label: 'Senior Mgmt', dot: 'var(--blue)' }] },
  { date: 16, bars: [{ label: 'Mitra OOO', tone: 'violet' }] },
  { date: 17, bars: [{ label: '', tone: 'violet' }], events: [{ label: 'Tech Wk Check', dot: 'var(--violet)' }] },
  { date: 18, events: [{ label: 'PLT Platform', dot: 'var(--blue)' }] },
  { date: 19, today: true, bars: [{ label: 'Juneteenth', tone: 'gold' }] },
  { date: 20, events: [{ label: "Children's Fest", dot: 'var(--gold)' }] },
  { date: 21, last: true, events: [{ label: "Father's Day", dot: 'var(--gold)' }] },

  { date: 22, bars: [{ label: 'Taylor OOO', tone: 'green' }] },
  { date: 23, bars: [{ label: '', tone: 'green' }], events: [{ label: 'TTL Episode', dot: 'var(--teal)' }] },
  { date: 24, bars: [{ label: '', tone: 'green' }], events: [{ label: 'Commercial Ld', dot: 'var(--blue)' }] },
  { date: 25, events: [{ label: 'Podcast Anniv.', dot: 'var(--teal)' }] },
  { date: 26, events: [{ label: 'Social Media', dot: 'var(--violet)' }] },
  { date: 27, events: [] },
  { date: 28, last: true, events: [{ label: 'Sunday Mass', dot: 'var(--gold)' }] },

  { date: 29, events: [{ label: 'SMT Block', dot: 'var(--blue)' }] },
  { date: 30, events: [{ label: 'Product Ld', dot: 'var(--blue)' }] },
  { date: 1, dim: true, events: [] },
  { date: 2, dim: true, events: [] },
  { date: 3, dim: true, events: [{ label: 'Wistia Holiday', dot: 'var(--gold)', faded: true }] },
  { date: 4, dim: true, events: [{ label: 'July 4', dot: 'var(--gold)', faded: true }] },
  { date: 5, dim: true, last: true, events: [] },
];
export const CAL_BAR_TONE = {
  blue: { bg: 'rgba(123,182,255,.18)', color: '#9cc7ff' },
  green: { bg: 'rgba(91,217,127,.18)', color: '#8fe3ab' },
  violet: { bg: 'rgba(169,155,245,.18)', color: '#c9b6ff' },
  gold: { bg: 'rgba(232,194,104,.2)', color: '#f0d493' },
};
