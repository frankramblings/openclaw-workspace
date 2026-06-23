// INBOX surface → real unified-triage backend.
// Wires GET /api/items into state.live.inbox.items in the INBOX mock shape,
// and overrides dismiss/triageAll to POST /api/items/action.
// Render (surfaces.js inboxSurface) derives source counts, the needs/fyi
// split, and the dismissed filter itself — we only produce the item list.
// Fails soft: load() throws on error, which keeps the mock.

import { runtime } from './runtime.js';
import { apiGet, apiJson } from './api.js';

// Per-source brand colors, matching the mock's src-tag styling.
const SRC_STYLE = {
  GMAIL: { srcColor: 'var(--red)', srcBg: 'rgba(240,114,106,.12)' },
  SLACK: { srcColor: 'var(--green)', srcBg: 'rgba(91,217,127,.12)' },
  ASANA: { srcColor: 'var(--gold)', srcBg: 'rgba(232,194,104,.12)' },
};

const ageLabel = (h) => {
  const n = Number(h) || 0;
  return n < 24 ? `${Math.round(n)}h` : `${Math.round(n / 24)}d`;
};

// Pick a sensible primary CTA label from the backend's allowed actions list.
const PRIMARY_LABEL = {
  reply: 'Reply',
  respond: 'Respond',
  open: 'Open',
  open_doc: 'Open doc',
  view: 'Open',
};
function primaryLabel(actions) {
  const a = Array.isArray(actions) ? actions : [];
  for (const act of a) {
    const k = String(act).toLowerCase();
    if (PRIMARY_LABEL[k]) return PRIMARY_LABEL[k];
  }
  return 'Reply';
}

// Per-source "clear it" action. Wrong combo → 400 from the backend
// (e.g. gmail rejects mark_read, slack rejects archive), so we map carefully
// and fall back to the universal 'dismiss' on a 400.
function dismissAction(source) {
  switch (String(source || '').toLowerCase()) {
    case 'gmail': return 'archive';
    case 'slack': return 'mark_read';
    case 'asana': return 'complete';
    default: return 'dismiss';
  }
}

function toMockItem(it) {
  const src = String(it.source || '').toUpperCase();
  const style = SRC_STYLE[src] || { srcColor: 'var(--muted)', srcBg: 'rgba(255,255,255,.06)' };
  const rec = it.rec || null;
  const group = rec && rec.action === 'archive' ? 'fyi' : 'needs';
  return {
    id: String(it.id),
    source: it.source,           // kept for action dispatch (not rendered)
    group,
    src,
    srcColor: style.srcColor,
    srcBg: style.srcBg,
    who: it.title || '',
    time: ageLabel(it.ageHours),
    unread: !!(it.meta && it.meta.unread),
    body: it.snippet || it.subtitle || '',
    // needs fields
    primary: primaryLabel(it.actions),
    secondary: 'Mark read',
    // fyi fields
    aiArchive: !!(rec && rec.action === 'archive'),
    suggest: (rec && rec.reason) || 'Archive',
  };
}

export async function load(state) {
  const raw = await apiGet('/api/items?limit=200');
  const list = Array.isArray(raw && raw.items) ? raw.items : [];
  const items = list.map(toMockItem);
  state.live.inbox = { items };
}

// Optimistically remove an item from the visible feed, re-render, then fire
// the backend action. Re-render again on resolution.
function markDismissed(state, id) {
  const sid = String(id);
  if (!state.dismissed.includes(sid)) state.dismissed = [...state.dismissed, sid];
}

export const actions = {
  dismiss: async (id) => {
    const state = runtime.state;
    const items = (state.live && state.live.inbox && state.live.inbox.items) || [];
    const item = items.find((m) => m.id === String(id));
    const source = item ? item.source : undefined;

    // optimistic
    markDismissed(state, id);
    runtime.render();

    const action = dismissAction(source);
    try {
      const r = await apiJson('/api/items/action', { source, id: String(id), action });
      if (r && r.ok === false && action !== 'dismiss') {
        // wrong action/source combo → fall back to the universal dismiss.
        await apiJson('/api/items/action', { source, id: String(id), action: 'dismiss' });
      }
    } catch (e) {
      // Treat a 400 (rejected combo) as "retry with dismiss"; otherwise give up.
      if (action !== 'dismiss') {
        try { await apiJson('/api/items/action', { source, id: String(id), action: 'dismiss' }); } catch (_) {}
      }
    }
    runtime.render();
  },

  triageAll: async () => {
    const state = runtime.state;
    const items = (state.live && state.live.inbox && state.live.inbox.items) || [];
    const fyi = items.filter((m) => m.group === 'fyi');

    // optimistic: clear the whole FYI batch to inbox-zero.
    for (const it of fyi) markDismissed(state, it.id);
    runtime.render();

    for (const it of fyi) {
      const action = dismissAction(it.source);
      try {
        const r = await apiJson('/api/items/action', { source: it.source, id: it.id, action });
        if (r && r.ok === false && action !== 'dismiss') {
          await apiJson('/api/items/action', { source: it.source, id: it.id, action: 'dismiss' });
        }
      } catch (e) {
        if (action !== 'dismiss') {
          try { await apiJson('/api/items/action', { source: it.source, id: it.id, action: 'dismiss' }); } catch (_) {}
        }
      }
    }
    runtime.render();
  },
};
