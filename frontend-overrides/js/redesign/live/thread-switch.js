// Per-thread state that must survive switching threads: the composer draft,
// the scroll position, and a most-recently-used list for the switcher.
// Pure functions over plain objects. `storage` is injected (localStorage in
// the app, a stub in tests) and every storage call is guarded, because
// Safari private mode and quota errors throw.

export const DRAFT_KEY = 'oc-drafts';
export const MRU_KEY = 'oc-mru';
export const DRAFT_CAP = 50;
export const MRU_CAP = 20;
export const BOTTOM_GAP_PX = 16;

export function capDrafts(drafts, cap = DRAFT_CAP) {
  const entries = Object.entries(drafts || {});
  if (entries.length <= cap) return Object.fromEntries(entries);
  entries.sort((a, b) => ((b[1] && b[1].at) || 0) - ((a[1] && a[1].at) || 0));
  return Object.fromEntries(entries.slice(0, cap));
}

export function saveDraft(drafts, id, text, now = Date.now()) {
  const next = { ...(drafts || {}) };
  if (!id) return next;
  const t = String(text || '');
  if (!t.trim()) { delete next[id]; return next; }
  next[id] = { text: t, at: now };
  return capDrafts(next);
}

export function restoreDraft(drafts, id) {
  const d = drafts && id ? drafts[id] : null;
  return d && typeof d.text === 'string' ? d.text : '';
}

export function dropDraft(drafts, id) {
  const next = { ...(drafts || {}) };
  if (id) delete next[id];
  return next;
}

export function loadDrafts(storage) {
  try {
    const raw = storage.getItem(DRAFT_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const clean = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.text === 'string') clean[k] = { text: v.text, at: Number(v.at) || 0 };
    }
    return capDrafts(clean);
  } catch (_) { return {}; }
}

export function persistDrafts(drafts, storage) {
  try { storage.setItem(DRAFT_KEY, JSON.stringify(drafts || {})); } catch (_) { /* storage unavailable */ }
}

export function scrollSnapshot(scrollTop, scrollHeight, clientHeight) {
  const top = Math.max(0, Math.floor(Number(scrollTop) || 0));
  const gap = (Number(scrollHeight) || 0) - top - (Number(clientHeight) || 0);
  return { top, atBottom: gap <= BOTTOM_GAP_PX };
}

export function scrollDecision(saved, finishedWhileAway) {
  if (!saved || saved.atBottom || finishedWhileAway) return { bottom: true, top: null };
  return { bottom: false, top: saved.top };
}

export function pushMru(list, id, cap = MRU_CAP) {
  const base = Array.isArray(list) ? list : [];
  if (!id) return [...base];
  return [id, ...base.filter((x) => x !== id)].slice(0, cap);
}

export function loadMru(storage) {
  try {
    const raw = storage.getItem(MRU_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string').slice(0, MRU_CAP) : [];
  } catch (_) { return []; }
}

export function persistMru(list, storage) {
  try { storage.setItem(MRU_KEY, JSON.stringify(Array.isArray(list) ? list : [])); } catch (_) { /* storage unavailable */ }
}
