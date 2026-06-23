// Live wiring for the EMAIL surface (desktop reader + mobile list/reader).
// Reads real himalaya/IMAP data via the workspace app's /api/email/* routes
// and shapes it to match the EMAILS mock in ../data.js so the existing render
// (surfaces.js / mobile/mobile-surfaces.js) works unchanged. Fails soft: any
// throw keeps the mock; load() swallows errors so the UI never breaks.

import { runtime } from './runtime.js';
import { apiGet } from './api.js';

const FOLDER = 'INBOX';

// GMAIL badge styling, matching the mock's first item.
const SRC = { src: 'GMAIL', srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)' };

// Stable avatar palette (bg/fg pairs) keyed by a hash of the sender so the
// same person always gets the same color across renders.
const AV_PALETTE = [
  { avBg: '#3a2f47', avFg: '#c9b6ff' },
  { avBg: '#2f3a47', avFg: '#9cc7ff' },
  { avBg: '#243044', avFg: '#7bb6ff' },
  { avBg: '#3a3326', avFg: '#e8c268' },
  { avBg: '#26342b', avFg: '#5bd97f' },
  { avBg: '#3a2630', avFg: '#f0726a' },
  { avBg: '#26343a', avFg: '#5fd0d0' },
];

function avatarFor(seed) {
  const s = String(seed || '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return AV_PALETTE[Math.abs(h) % AV_PALETTE.length];
}

function initialsOf(name) {
  const s = String(name || '').trim();
  if (!s) return '?';
  const parts = s.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0].slice(0, 2).toUpperCase();
}

// Best-effort '04:12 PM' from either ISO ('2026-06-22T23:07+00:00') or RFC2822
// ('Mon, 22 Jun 2026 23:07:58 +0000'). Falls back to the raw string.
function shortTime(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return String(date);
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
}

function fmtBytes(n) {
  const b = Number(n);
  if (!b || b < 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${Math.round(b / 1024)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

// Strip HTML to readable text: drop script/style, turn block boundaries into
// blank lines so paragraphsFrom can split, decode common entities.
function stripHtml(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<\s*(script|style|head|title)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  // Paragraph / block ends → blank line; <br> → single newline.
  s = s.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  s = s.replace(/<\s*\/\s*(p|div|tr|table|li|h[1-6]|blockquote)\s*>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/gi, ' ')
       .replace(/&amp;/gi, '&')
       .replace(/&lt;/gi, '<')
       .replace(/&gt;/gi, '>')
       .replace(/&quot;/gi, '"')
       .replace(/&#39;|&apos;/gi, "'");
  // Collapse runs of spaces/tabs but keep newlines for paragraph splitting.
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function looksLikeHtml(s) {
  return typeof s === 'string' && /<[a-z!][\s\S]*>/i.test(s);
}

// Split a text body into paragraph strings (the mock's body:[] shape).
function paragraphsFrom(text) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  const paras = t.split(/\n{2,}/).map((p) => p.replace(/\n+/g, ' ').trim()).filter(Boolean);
  return paras.length ? paras : [t];
}

// list item → mock list shape.
function toListItem(e) {
  const fromName = e.from_name || e.from_address || '';
  return {
    ...SRC,
    subj: e.subject || '(no subject)',
    from: fromName,
    time: shortTime(e.date),
    unread: !e.is_read,
    uid: e.uid,
    folder: FOLDER,
    initials: initialsOf(fromName),
    ...avatarFor(e.from_address || fromName),
  };
}

// full read response → mock `current` shape.
function toCurrent(d) {
  const fromName = d.from_name || d.from_address || '';
  let bodyText = '';
  if (d.body && !looksLikeHtml(d.body)) bodyText = d.body;
  else bodyText = stripHtml(d.body_html || d.body || '');
  return {
    ...SRC,
    subj: d.subject || '(no subject)',
    from: fromName,
    fromMail: d.from_address || '',
    initials: initialsOf(fromName),
    ...avatarFor(d.from_address || fromName),
    to: d.to || 'me',
    time: shortTime(d.date),
    uid: d.uid,
    folder: FOLDER,
    unread: false,
    body: paragraphsFrom(bodyText),
    attach: (d.attachments || []).map((a) => ({ name: a.filename, size: fmtBytes(a.size) })),
  };
}

async function readCurrent(uid) {
  const d = await apiGet(`/api/email/read/${encodeURIComponent(uid)}?folder=${encodeURIComponent(FOLDER)}&mark_seen=false`);
  return toCurrent(d);
}

export async function load(state) {
  const res = await apiGet(`/api/email/list?folder=${encodeURIComponent(FOLDER)}&limit=50`);
  const emails = (res?.emails || []).map(toListItem);
  if (!emails.length) throw new Error('email/list returned no rows');

  // Prefetch the first message so the reader isn't empty on load. If this
  // fails, leave current undefined — render falls back to emails[sel].
  let current;
  try { current = await readCurrent(emails[0].uid); } catch (_) { current = undefined; }

  state.live = state.live || {};
  state.live.email = { emails, current };
}

async function openAt(i) {
  const s = runtime.state;
  if (!s) return;
  const idx = Number(i);
  s.selEmail = idx;
  const emails = s.live?.email?.emails || [];
  const item = emails[idx];
  if (!item) { runtime.render(); return; }
  runtime.render(); // optimistic: selection + (stale/mock) current
  try {
    const current = await readCurrent(item.uid);
    s.live = s.live || {};
    s.live.email = { emails, current };
  } catch (_) { /* keep prior current; render still shows the list selection */ }
  runtime.render();
}

export const actions = {
  // Desktop reader: select a row and load its full message.
  selEmail: (i) => openAt(i),
  // Mobile reader: same, but also flip into the reader view.
  mOpenReader: (i) => {
    const s = runtime.state;
    if (s) s.mReader = true;
    return openAt(i);
  },
};
