// The sidebar/drawer group model (spec 7.1). Pure: takes the raw session list
// plus the live sets and returns ordered sections with a `kind` discriminator.
// Sections OVERLAP by design (2026-10-14 pinned-sections): a thread shows in
// every section it qualifies for. PINNED leads and holds every starred thread;
// OPEN is the working set (activity-driven, capped); PROJECTS group filed
// threads with roll-ups; unfiled threads also sit in their date buckets.
// Both renderers consume this; nothing here touches the DOM.

export const OPEN_WINDOW_MS = 48 * 3600 * 1000;
export const OPEN_CAP = 8;

const _MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Date bucket label for an unfiled session. Named buckets for the last two
// weeks, then by month so the full history stays reachable by scrolling.
export function bucketFor(updated, now) {
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const dow = (new Date(now).getDay() + 6) % 7;   // week starts Monday, local time
  const weekStart = today - dow * 86400000;
  const lastWeekStart = weekStart - 7 * 86400000;
  const u = startOfDay(updated || 0);
  if (u >= today) return 'TODAY';
  if (u >= yesterday) return 'YESTERDAY';
  if (u >= weekStart) return 'THIS WEEK';
  if (u >= lastWeekStart) return 'LAST WEEK';
  const d = new Date(updated || 0);
  const yr = d.getFullYear();
  return yr === new Date(now).getFullYear() ? _MONTHS[d.getMonth()] : `${_MONTHS[d.getMonth()]} ${yr}`;
}

const ts = (s) => s.updated || s.created || 0;

function rowOf(s, activeId, live) {
  const active = s.id === activeId;
  return {
    id: s.id,
    title: s.name || 'New chat',
    term: !!s.gary_terminal,
    active,
    important: !!s.important,
    model: s.model || '',
    endpointId: s.endpoint_id || '',
    parentId: s.parent_id || null,
    folder: s.folder || null,
    // The dot means "something here you have not seen": a reply that landed
    // while you were away (client-side, this session) OR a stored manual
    // "Mark unread". `unread` is kept on the row too so the menu can flip
    // its label without reaching back into the session record.
    unread: !!s.unread,
    notify: !active && (live.notified.has(s.id) || !!s.unread),
    working: !active && live.running.has(s.id),
    queued: !active && live.queued.has(s.id),
    depth: 0,
  };
}

// Forks render under their parent when the parent is in the same list
// (depth capped at 2); pinned rows float first. Rows arrive newest-first and
// the sort is stable, so recency is preserved within each tier. A parent
// cycle (a→b→a) can leave rows unemitted; they are appended flat.
export function orderWithForks(rows) {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map();
  const top = [];
  for (const r of rows) {
    const pid = r.parentId;
    if (pid && pid !== r.id && ids.has(pid)) {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(r);
    } else top.push(r);
  }
  top.sort((a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0));
  const out = [];
  const seen = new Set();
  const emit = (r, depth) => {
    if (seen.has(r.id)) return;
    seen.add(r.id);
    out.push({ ...r, depth });
    for (const c of (children.get(r.id) || [])) emit(c, Math.min(depth + 1, 2));
  };
  for (const r of top) emit(r, 0);
  for (const r of rows) if (!seen.has(r.id)) { seen.add(r.id); out.push({ ...r, depth: 0 }); }
  return out;
}

export function buildThreadGroups({ sessions, projects, running, notified, queued, now, activeId, expanded, collapsed } = {}) {
  const live = {
    running: running instanceof Set ? running : new Set(),
    notified: notified instanceof Set ? notified : new Set(),
    queued: queued instanceof Set ? queued : new Set(),
  };
  const nowMs = typeof now === 'number' ? now : Date.now();
  const exp = expanded instanceof Set ? expanded : new Set();
  // Explicit collapse beats every auto-expand rule, including "holds the
  // active thread" — the active row still shows on the OPEN shelf, so a
  // collapsed project never hides where you are.
  const forced = collapsed instanceof Set ? collapsed : new Set();
  const list = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.id && !s.archived)
    .slice()
    .sort((a, b) => ts(b) - ts(a));
  const projById = new Map((Array.isArray(projects) ? projects : []).filter((p) => p && p.id).map((p) => [p.id, p]));

  // PINNED: every starred thread, regardless of project or OPEN membership.
  // Pinning is explicit, so an archived project does not hide a pinned thread
  // here. Recency order, flat.
  const groups = [];
  const pinnedRows = list.filter((s) => s.important).map((s) => rowOf(s, activeId, live));
  if (pinnedRows.length) groups.push({ kind: 'pinned', label: '★ PINNED', rows: pinnedRows, meta: { count: pinnedRows.length } });

  // OPEN: activity-driven working set. Ignores project filing entirely
  // (spec: "OPEN ignores projects") so a running or active thread always
  // surfaces here regardless of what project it is filed under.
  const inWindow = (s) => typeof s.opened === 'number' && s.opened > 0 && (nowMs - s.opened) <= OPEN_WINDOW_MS;
  const pinnedOpen = (s) => live.running.has(s.id) || s.id === activeId;
  const candidates = list.filter((s) => inWindow(s) || live.running.has(s.id) || live.queued.has(s.id) || s.id === activeId);
  // Deviation from the spec's running-first order: candidates keep `list`'s
  // recency (ts) order, so a thread that starts or stops running does not
  // reshuffle every Option+N slot. Running and active rows are still
  // guaranteed a place by the cap-yield loop below, just not the first one.
  const keep = candidates.slice();
  while (keep.length > OPEN_CAP) {
    let idx = -1;
    for (let i = keep.length - 1; i >= 0; i--) { if (!pinnedOpen(keep[i])) { idx = i; break; } }
    if (idx === -1) break;   // only running/active rows left; the cap yields
    keep.splice(idx, 1);
  }
  if (keep.length) {
    groups.push({
      kind: 'open', label: 'OPEN',
      rows: keep.map((s, i) => ({ ...rowOf(s, activeId, live), slot: i < 9 ? i + 1 : null })),
      meta: { count: keep.length },
    });
  }

  // PROJECTS: roll-ups and ordering consider every non-archived session filed
  // under the project. Rows list every filed session, including ones also on
  // the OPEN shelf (sections overlap). Archived projects hide their threads
  // here; an unknown project id reads as unfiled (spec 8).
  const byProject = new Map();
  const unfiled = [];
  for (const s of list) {
    const p = s.folder ? projById.get(s.folder) : null;
    if (!p) { unfiled.push(s); continue; }
    if (p.archived) continue;
    if (!byProject.has(p.id)) byProject.set(p.id, { all: [], rows: [] });
    const bucket = byProject.get(p.id);
    bucket.all.push(s);
    bucket.rows.push(s);
  }
  const projGroups = [];
  for (const [pid, bucket] of byProject) {
    const p = projById.get(pid);
    const ordered = orderWithForks(bucket.rows.map((s) => rowOf(s, activeId, live)));
    const containsActive = bucket.all.some((s) => s.id === activeId);
    projGroups.push({
      kind: 'project', label: p.name || 'Project', rows: ordered,
      meta: {
        id: pid, count: bucket.all.length,
        working: bucket.all.filter((s) => live.running.has(s.id)).length,
        unseen: bucket.all.filter((s) => live.notified.has(s.id) || s.unread).length,
        collapsed: forced.has(pid) || (!containsActive && !exp.has(pid)),
        latest: bucket.all.reduce((m, s) => Math.max(m, ts(s)), 0),
      },
    });
  }
  projGroups.sort((a, b) => b.meta.latest - a.meta.latest);
  groups.push(...projGroups);

  // Unfiled: date buckets. Pinned and OPEN unfiled threads appear here too.
  const byLabel = new Map();
  for (const s of unfiled) {
    const label = bucketFor(s.updated, nowMs);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(rowOf(s, activeId, live));
  }
  for (const [label, rows] of byLabel) groups.push({ kind: 'recent', label, rows, meta: {} });
  return groups;
}
