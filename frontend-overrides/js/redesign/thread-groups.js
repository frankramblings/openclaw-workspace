// The sidebar/drawer group model (spec 7.1). Pure: takes the raw session list
// plus the live sets and returns ordered sections with a `kind` discriminator.
// OPEN is the working set (activity-driven, capped), PROJECTS group filed
// threads with roll-ups, and unfiled threads keep the classic PINNED + date
// buckets. Both renderers consume this; nothing here touches the DOM.

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
    notify: !active && live.notified.has(s.id),
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

export function buildThreadGroups({ sessions, projects, running, notified, queued, now, activeId, expanded } = {}) {
  const live = {
    running: running instanceof Set ? running : new Set(),
    notified: notified instanceof Set ? notified : new Set(),
    queued: queued instanceof Set ? queued : new Set(),
  };
  const nowMs = typeof now === 'number' ? now : Date.now();
  const exp = expanded instanceof Set ? expanded : new Set();
  const list = (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && s.id && !s.archived)
    .slice()
    .sort((a, b) => ts(b) - ts(a));
  const projById = new Map((Array.isArray(projects) ? projects : []).filter((p) => p && p.id).map((p) => [p.id, p]));

  // OPEN: activity-driven working set.
  const inWindow = (s) => typeof s.opened === 'number' && s.opened > 0 && (nowMs - s.opened) <= OPEN_WINDOW_MS;
  const pinnedOpen = (s) => live.running.has(s.id) || s.id === activeId;
  const isFiled = (s) => !!s.folder && projById.has(s.folder);
  const candidates = list.filter((s) => {
    // Active or recently opened always included
    if (s.id === activeId || inWindow(s)) return true;
    // Running/queued only if unfiled
    if (!isFiled(s)) return live.running.has(s.id) || live.queued.has(s.id);
    return false;
  });
  candidates.sort((a, b) => {
    const ra = live.running.has(a.id) ? 1 : 0;
    const rb = live.running.has(b.id) ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return (b.opened || 0) - (a.opened || 0);
  });
  const keep = candidates.slice();
  while (keep.length > OPEN_CAP) {
    let idx = -1;
    for (let i = keep.length - 1; i >= 0; i--) { if (!pinnedOpen(keep[i])) { idx = i; break; } }
    if (idx === -1) break;   // only running/active rows left; the cap yields
    keep.splice(idx, 1);
  }
  const openIds = new Set(keep.map((s) => s.id));
  const groups = [];
  if (keep.length) {
    groups.push({
      kind: 'open', label: 'OPEN',
      rows: keep.map((s, i) => ({ ...rowOf(s, activeId, live), slot: i < 9 ? i + 1 : null })),
      meta: { count: keep.length },
    });
  }

  // PROJECTS: filed threads not already on the shelf. Archived projects hide
  // their threads; an unknown project id reads as unfiled (spec 8).
  const byProject = new Map();
  const unfiled = [];
  for (const s of list) {
    if (openIds.has(s.id)) continue;
    const p = s.folder ? projById.get(s.folder) : null;
    if (!p) { unfiled.push(s); continue; }
    if (p.archived) continue;
    if (!byProject.has(p.id)) byProject.set(p.id, []);
    byProject.get(p.id).push(s);
  }
  const projGroups = [];
  for (const [pid, rows] of byProject) {
    const p = projById.get(pid);
    const ordered = orderWithForks(rows.map((s) => rowOf(s, activeId, live)));
    const containsActive = rows.some((s) => s.id === activeId);
    projGroups.push({
      kind: 'project', label: p.name || 'Project', rows: ordered,
      meta: {
        id: pid, count: rows.length,
        working: rows.filter((s) => live.running.has(s.id)).length,
        unseen: rows.filter((s) => live.notified.has(s.id)).length,
        collapsed: !containsActive && !exp.has(pid),
        latest: rows.reduce((m, s) => Math.max(m, ts(s)), 0),
      },
    });
  }
  projGroups.sort((a, b) => b.meta.latest - a.meta.latest);
  groups.push(...projGroups);

  // Unfiled: PINNED shelf then date buckets, as before.
  const pinned = unfiled.filter((s) => s.important).map((s) => rowOf(s, activeId, live));
  if (pinned.length) groups.push({ kind: 'pinned', label: '★ PINNED', rows: pinned, meta: {} });
  const byLabel = new Map();
  for (const s of unfiled) {
    if (s.important) continue;
    const label = bucketFor(s.updated, nowMs);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(rowOf(s, activeId, live));
  }
  for (const [label, rows] of byLabel) groups.push({ kind: 'recent', label, rows, meta: {} });
  return groups;
}
