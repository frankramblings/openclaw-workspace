// The ⌘K switcher: most-recent-first list of threads, title matches while
// typing, and semantic message hits from /api/search. Section building and
// selection math are pure; renderSwitcher only turns state into HTML.
import { esc, map } from './dom.js';
import { I } from './icons.js';

export const RECENT_LIMIT = 8;
export const THREAD_LIMIT = 12;

function liveSessions(sessions) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => s && s.id && !s.archived);
}

function projectName(session, projects) {
  if (!session || !session.folder || !Array.isArray(projects)) return '';
  const p = projects.find((x) => x && x.id === session.folder);
  return p ? String(p.name || '') : '';
}

export function buildSwitcherSections({ query, sessions, mru, searchResults, activeId, projects } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const live = liveSessions(sessions);
  const byId = new Map(live.map((s) => [s.id, s]));
  const row = (s) => ({ id: s.id, title: s.name || 'New chat', project: projectName(s, projects), active: s.id === activeId });
  const sections = [];
  if (!q) {
    const rows = (Array.isArray(mru) ? mru : []).map((id) => byId.get(id)).filter(Boolean).slice(0, RECENT_LIMIT).map(row);
    if (rows.length) sections.push({ label: 'RECENT', rows });
    return sections;
  }
  const rows = live
    .filter((s) => String(s.name || '').toLowerCase().includes(q))
    .sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0))
    .slice(0, THREAD_LIMIT)
    .map(row);
  if (rows.length) sections.push({ label: 'THREADS', rows });
  const shown = new Set(rows.map((r) => r.id));
  const seen = new Set();
  const hits = [];
  for (const h of (Array.isArray(searchResults) ? searchResults : [])) {
    if (!h || !h.session_id || shown.has(h.session_id) || seen.has(h.session_id)) continue;
    seen.add(h.session_id);
    const s = byId.get(h.session_id);
    hits.push({
      id: h.session_id,
      title: h.session_name || (s && s.name) || 'Conversation',
      project: projectName(s, projects),
      active: h.session_id === activeId,
      snippet: String(h.content_snippet || ''),
    });
  }
  if (hits.length) sections.push({ label: 'MESSAGES', rows: hits });
  return sections;
}

export function flatRows(sections) {
  return (Array.isArray(sections) ? sections : []).flatMap((s) => s.rows || []);
}

export function clampSel(sel, n) {
  if (!n || n <= 0) return 0;
  const i = Number(sel) || 0;
  return ((i % n) + n) % n;
}

// Rows for the sidebar/drawer RECENT group. Same shape live/chat.js's
// buildGroups emits so the existing row renderers accept them unchanged.
export function mruRows(mru, sessions, activeId, limit = 5) {
  const byId = new Map(liveSessions(sessions).map((s) => [s.id, s]));
  const out = [];
  for (const id of (Array.isArray(mru) ? mru : [])) {
    const s = byId.get(id);
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.name || 'New chat',
      term: !!s.gary_terminal,
      active: s.id === activeId,
      important: !!s.important,
      model: s.model || '',
      endpointId: s.endpoint_id || '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Copy live indicator flags from already-annotated sidebar rows onto rows
// rebuilt from the MRU (the drawer's RECENT group), so a thread never shows
// a dot in one group and none in another.
export function mergeLiveFlags(rows, groups) {
  const byId = new Map();
  for (const g of (Array.isArray(groups) ? groups : [])) for (const r of (g.rows || [])) if (r && r.id) byId.set(r.id, r);
  return (Array.isArray(rows) ? rows : []).map((r) => {
    const a = byId.get(r.id);
    return a ? { ...r, notify: !!a.notify, working: !!a.working } : { ...r, notify: false, working: false };
  });
}

export function renderSwitcher(s) {
  const chat = (s && s.live && s.live.chat) || {};
  const sections = buildSwitcherSections({
    query: s.switchQuery, sessions: chat.sessions, mru: chat.mru,
    searchResults: chat.switcherResults, activeId: chat.activeId, projects: (s.live && s.live.projects) || [],
  });
  const flat = flatRows(sections);
  const sel = clampSel(chat.switcherSel, flat.length);
  let idx = -1;
  const rowHtml = (r) => {
    idx += 1;
    const on = idx === sel;
    return `<div class="conv-row sw-row${on ? ' active' : ''}" data-act="switcherPick" data-arg="${esc(r.id)}" role="option" aria-selected="${on}">`
      + `<span class="conv-badge">G</span>`
      + (r.snippet
        ? `<span class="conv-hit"><span class="conv-title">${esc(r.title)}</span><span class="conv-hit-snip">${esc(r.snippet)}</span></span>`
        : `<span class="conv-title">${esc(r.title)}</span>`)
      + (r.project ? `<span class="sw-proj">${esc(r.project)}</span>` : '')
      + `</div>`;
  };
  const body = flat.length
    ? map(sections, (sec) => `<div class="conv-group"><span class="sect-label">${esc(sec.label)}</span></div>${map(sec.rows, rowHtml)}`)
    : `<div class="conv-empty" style="padding:14px;color:var(--faint);font-size:13px">${String(s.switchQuery || '').trim() ? 'No matches.' : 'No recent conversations yet.'}</div>`;
  return `
  <div class="oc-switcher-scrim" data-act="closeSwitcher" aria-hidden="true"></div>
  <div class="oc-switcher" role="dialog" aria-modal="true" aria-label="Switch conversation">
    <div class="oc-search sw-search">${I.search()}<input data-model="switchQuery" data-focus="switchQuery" placeholder="Jump to a conversation…" value="${esc(s.switchQuery || '')}" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" role="combobox" aria-expanded="true"></div>
    <div class="sw-list" role="listbox">${body}</div>
    <div class="sw-foot"><span>↑↓ move</span><span>↵ open</span><span>esc close</span></div>
  </div>`;
}
