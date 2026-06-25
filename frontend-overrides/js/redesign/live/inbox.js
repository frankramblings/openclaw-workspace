// INBOX surface → real unified-triage backend.
// Wires GET /api/items into state.live.inbox in the INBOX render shape, and
// exposes the real per-source actions the classic inbox had (archive, delete,
// mark_read, complete, reviewed, dismiss) plus click-out and source filtering.
// Render (surfaces.js inboxSurface) derives the needs/fyi split, the card
// action buttons (via cardActions), counts and the dismissed/filter views.
// Fails soft: load() throws on error, which keeps the mock.

import { runtime } from './runtime.js';
import { apiGet, apiJson } from './api.js';
import { srcStyle, openUrlFor, dueChipToISO } from './inbox-logic.js';

const ageLabel = (h) => {
  const n = Number(h) || 0;
  return n < 24 ? `${Math.round(n)}h` : `${Math.round(n / 24)}d`;
};

// Pick a sensible primary CTA label from the backend's allowed actions list —
// kept for the mobile mock fallback; desktop derives buttons from cardActions.
const PRIMARY_LABEL = {
  reply: 'Reply', respond: 'Respond', open: 'Open',
  open_doc: 'Open doc', view: 'Open', archive: 'Archive',
  mark_read: 'Mark read', complete: 'Complete', reviewed: 'Reviewed',
};
function primaryLabel(actions) {
  const a = Array.isArray(actions) ? actions : [];
  for (const act of a) {
    const k = String(act).toLowerCase();
    if (PRIMARY_LABEL[k]) return PRIMARY_LABEL[k];
  }
  return 'Open';
}

function toItem(it) {
  const src = String(it.source || '').toUpperCase();
  const style = srcStyle(it.source);
  const rec = it.rec || null;
  // FYI = the AI/heuristic wants this gone (archive). Everything else needs you.
  const group = rec && rec.action === 'archive' ? 'fyi' : 'needs';
  return {
    id: String(it.id),
    source: it.source,            // for action dispatch
    actions: Array.isArray(it.actions) ? it.actions : [],
    rec,                          // { action, by, reason, confidence }
    meta: it.meta || {},
    group,
    src,
    srcColor: style.srcColor,
    srcBg: style.srcBg,
    who: it.title || '',
    time: ageLabel(it.ageHours),
    unread: !!(it.meta && it.meta.unread),
    body: it.snippet || it.subtitle || '',
    // labels used by the mobile mock card
    primary: primaryLabel(it.actions),
    secondary: 'Mark read',
    suggest: (rec && rec.reason) || 'Archive',
  };
}

export async function load(state) {
  const raw = await apiGet('/api/items?limit=200');
  const list = Array.isArray(raw && raw.items) ? raw.items : [];
  state.live.inbox = {
    items: list.map(toItem),
    sources: (raw && raw.sources) || null,   // authoritative per-source totals
    errors: (raw && raw.errors) || null,     // per-source failures for ⚠ chips
  };
  if (state.inboxFilter === undefined) state.inboxFilter = null;
}

// --- optimistic feed mutation ----------------------------------------------
function markDismissed(state, id) {
  const sid = String(id);
  if (!state.dismissed.includes(sid)) state.dismissed = [...state.dismissed, sid];
}
function unmarkDismissed(state, id) {
  const sid = String(id);
  state.dismissed = state.dismissed.filter((x) => x !== sid);
}
function findItem(state, id) {
  const items = (state.live && state.live.inbox && state.live.inbox.items) || [];
  return items.find((m) => m.id === String(id));
}

async function reloadInbox(state) {
  await load(state);
}

// Open a URL in a new tab without leaking window.opener.
function openExternal(url) {
  try {
    const a = document.createElement('a');
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    document.body.appendChild(a); a.click(); a.remove();
  } catch (_) { /* non-browser context (tests) */ }
}

// Core per-source action: optimistic remove → POST → revert on failure.
// `action` is a verb the backend already declared valid for this item, so we
// trust it (no dismiss fallback dance like the universal ✕ needs).
async function runAction(id, action) {
  const state = runtime.state;
  const item = findItem(state, id);
  if (!item) return;
  const source = item.source;

  markDismissed(state, id);
  runtime.render();
  try {
    const r = await apiJson('/api/items/action', { source, id: String(id), action });
    if (r && r.ok === false) throw new Error(r.error || 'action failed');
    if (r && r.undoTs) state._lastUndoTs = r.undoTs;   // consumed in slice C
  } catch (e) {
    unmarkDismissed(state, id);                         // snap the card back
    runtime.render();
    return;
  }
  runtime.render();
}

export const actions = {
  // Obsidian capture: create an Asana task from the surfaced commitment.
  addAsana: async (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    const rec = item.rec || {};
    const payload = {
      source: item.source, id: String(id), action: 'add_asana',
      title: item.who, task: rec.task || item.who,
      due: rec.due || null, snippet: item.body, meta: item.meta || {},
    };
    markDismissed(state, id);
    runtime.render();
    try {
      const r = await apiJson('/api/items/action', payload);
      if (r && r.ok === false) throw new Error(r.error || 'add failed');
      if (r && r.undoTs) {
        state._lastUndoTs = r.undoTs;
        state.inboxToast = { msg: `Added → ${payload.due ? 'due ' + payload.due : 'no due date'}`, undoTs: r.undoTs };
      }
    } catch (e) {
      unmarkDismissed(state, id);
      state.inboxToast = { msg: "Couldn't add to Asana — retry", undoTs: null };
    }
    runtime.render();
  },

  // Open the quick edit sheet (long-press / "Edit") to adjust name + due first.
  addAsanaEdit: (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    const rec = item.rec || {};
    state.inboxEditFor = { id: String(id), task: rec.task || item.who, due: rec.due || null };
    runtime.render();
  },
  pickDue: (chip) => {
    const state = runtime.state;
    if (!state.inboxEditFor) return;
    state.inboxEditFor = { ...state.inboxEditFor, due: dueChipToISO(chip, Date.now()) };
    runtime.render();
  },
  closeEdit: () => { runtime.state.inboxEditFor = null; runtime.render(); },
  confirmAddAsana: async () => {
    const state = runtime.state;
    const edit = state.inboxEditFor;
    if (!edit) return;
    const item = findItem(state, edit.id);
    state.inboxEditFor = null;
    if (!item) { runtime.render(); return; }
    markDismissed(state, edit.id);
    runtime.render();
    try {
      const r = await apiJson('/api/items/action', {
        source: item.source, id: edit.id, action: 'add_asana',
        title: item.who, task: edit.task, due: edit.due,
        snippet: item.body, meta: item.meta || {},
      });
      if (r && r.ok === false) throw new Error(r.error || 'add failed');
      if (r && r.undoTs) { state._lastUndoTs = r.undoTs; state.inboxToast = { msg: `Added → ${edit.due ? 'due ' + edit.due : 'no due date'}`, undoTs: r.undoTs }; }
    } catch (e) {
      unmarkDismissed(state, edit.id);
      state.inboxToast = { msg: "Couldn't add to Asana — retry", undoTs: null };
    }
    runtime.render();
  },

  // Per-source real actions.
  archive: (id) => runAction(id, 'archive'),
  delete: (id) => runAction(id, 'delete'),
  mark_read: (id) => runAction(id, 'mark_read'),
  complete: (id) => runAction(id, 'complete'),
  reviewed: (id) => runAction(id, 'reviewed'),

  // Hand item to Gary — mint a chat session seeded with this item's context.
  gary: async (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    try {
      const r = await apiJson('/api/items/spinoff', {
        item: { source: item.source, title: item.who, subtitle: item.body, snippet: item.body, meta: item.meta || {} },
      });
      const sid = r && r.session_id;
      if (sid) {
        location.hash = '#chat';
        if (runtime.actions && runtime.actions.selectSession) runtime.actions.selectSession(String(sid));
      } else {
        state.inboxToast = { msg: "Couldn't hand to Gary", undoTs: null };
        runtime.render();
      }
    } catch (_) {
      state.inboxToast = { msg: "Couldn't hand to Gary", undoTs: null };
      runtime.render();
    }
  },

  // Universal ✕ — tolerant of source/action mismatch (falls back to dismiss).
  dismiss: async (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    const source = item ? item.source : undefined;
    markDismissed(state, id);
    runtime.render();
    try {
      const r = await apiJson('/api/items/action', { source, id: String(id), action: 'dismiss' });
      if (r && r.ok === false) { /* dismiss is local-only; ignore */ }
    } catch (_) { /* local-only action; keep optimistic state */ }
    runtime.render();
  },

  // Click-out to the original. Backend gives a deep link for slack/asana/
  // obsidian/documents; gmail resolves its Message-ID lazily.
  open: async (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    if (!item) return;
    const url = openUrlFor(item);
    if (url) { openExternal(url); return; }
    if (String(item.source).toLowerCase() === 'gmail' && item.meta && item.meta.uid) {
      let link = 'https://mail.google.com/mail/u/0/#inbox';
      try {
        const d = await apiGet(`/api/email/read/${encodeURIComponent(item.meta.uid)}?mark_seen=false`);
        const mid = d && d.message_id;
        if (mid) link = `https://mail.google.com/mail/u/0/#search/rfc822msgid:${encodeURIComponent(mid)}`;
      } catch (_) { /* fall back to inbox */ }
      openExternal(link);
    }
  },

  // Toggle the source-filter chip. arg is an uppercased src tag or 'ALL'.
  setFilter: (src) => {
    const state = runtime.state;
    const f = src && src !== 'ALL' ? String(src).toUpperCase() : null;
    // Tapping the active chip again clears the filter.
    state.inboxFilter = state.inboxFilter === f ? null : f;
  },

  triageAll: async () => {
    const state = runtime.state;
    state.inboxToast = { msg: 'Triaging…', undoTs: null };
    runtime.render();
    try {
      const r = await apiJson('/api/items/triage', {});
      if (r && r.ok === false) throw new Error(r.error || 'triage failed');
      await reloadInbox(state);   // refetch so rec chips appear
      state.inboxToast = { msg: `Triaged ${r.scored ?? 0} items`, undoTs: null };
    } catch (e) {
      state.inboxToast = { msg: "Triage unavailable — try again", undoTs: null };
    }
    runtime.render();
  },

  // Tappable AI rec chip: run the item's recommended action.
  applyRec: (id) => {
    const state = runtime.state;
    const item = findItem(state, id);
    const rec = item && item.rec;
    if (!rec || !rec.action) return;
    const fn = (rec.action === 'gary') ? actions.gary
      : (rec.action === 'add_asana') ? actions.addAsana
      : actions[rec.action];
    if (fn) fn(String(id));
  },
};
