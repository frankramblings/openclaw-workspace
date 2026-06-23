// Live wiring for the CHAT surface. Populates state.live.chat in the mock's
// shape (see surfaces.js renderChatList / chatSurface). Fails soft: if the
// session list can't be fetched, load() throws and the render keeps the mock.
//
// Shape produced:
//   state.live.chat = {
//     activeId,
//     groups: [{ label:'TODAY'|'YESTERDAY'|'EARLIER', rows:[{id,title,term,active}] }],
//     title, subtitle, model, usagePct, cwd,
//     thread: [{ role:'assistant'|'user', time, model?, text }]
//   }

import { runtime } from './runtime.js';
import { apiGet, apiForm, postStream } from './api.js';

// ---- helpers --------------------------------------------------------------

function fmtTime(ts) {
  if (ts == null) return '';
  const d = new Date(typeof ts === 'number' ? ts : Number(ts) || Date.parse(ts));
  if (isNaN(d.getTime())) return '';
  let h = d.getHours();
  const m = String(d.getMinutes()).padStart(2, '0');
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ap}`;
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function bucketFor(updated, now) {
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  const u = startOfDay(updated || 0);
  if (u >= today) return 'TODAY';
  if (u >= yesterday) return 'YESTERDAY';
  return 'EARLIER';
}

function buildGroups(sessions, activeId) {
  const now = Date.now();
  const order = ['TODAY', 'YESTERDAY', 'EARLIER'];
  const byLabel = { TODAY: [], YESTERDAY: [], EARLIER: [] };
  let count = 0;
  for (const s of sessions) {
    if (count >= 20) break;
    const label = bucketFor(s.updated, now);
    byLabel[label].push({
      id: s.id,
      title: s.name || 'New chat',
      term: !!s.gary_terminal,
      active: s.id === activeId,
    });
    count++;
  }
  return order
    .filter((label) => byLabel[label].length)
    .map((label) => ({ label, rows: byLabel[label] }));
}

function round1(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

function ensureChat(state) {
  if (!state.live) state.live = {};
  if (!state.live.chat) state.live.chat = {};
  return state.live.chat;
}

// Fetch + map history into a thread; returns { thread, title?, subtitle, model }.
async function fetchThread(id, fallbackModel, name) {
  const hist = await apiGet(`/api/history/${id}?limit=100`);
  const list = Array.isArray(hist?.history) ? hist.history : [];
  const model = hist?.model || fallbackModel || '';
  const thread = list.map((h) => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    text: h.content || '',
    time: fmtTime(h?.metadata?.timestamp),
    model: h?.metadata?.model || model,
  }));
  return {
    thread,
    title: name,
    subtitle: `${list.length} messages · ${model}`,
    model,
  };
}

async function fetchUsage(id) {
  try {
    const u = await apiGet(`/api/sessions/${id}/usage`);
    if (!u || !u.ok) return undefined;
    return round1(u?.context?.usedPct);
  } catch (_) {
    return undefined;
  }
}

// ---- load -----------------------------------------------------------------

export async function load(state) {
  // sessions list — if this throws, loader keeps the mock.
  const sessions = await apiGet('/api/sessions');
  const list = Array.isArray(sessions) ? sessions : [];

  const chat = ensureChat(state);
  const activeId = chat.activeId || (list[0] && list[0].id) || null;
  chat.activeId = activeId;

  // fallback model + cwd (best-effort)
  let fallbackModel = '';
  try {
    const dc = await apiGet('/api/default-chat');
    fallbackModel = dc?.model || '';
  } catch (_) { /* ignore */ }
  try {
    const cfg = await apiGet('/api/config');
    if (cfg?.workspace_root) chat.cwd = cfg.workspace_root;
  } catch (_) { /* ignore */ }

  chat.groups = buildGroups(list, activeId);

  const activeSession = list.find((s) => s.id === activeId);

  if (activeId) {
    try {
      const t = await fetchThread(activeId, fallbackModel, activeSession?.name);
      chat.thread = t.thread;
      chat.title = t.title || chat.title;
      chat.subtitle = t.subtitle;
      chat.model = t.model || fallbackModel;
    } catch (_) {
      chat.thread = chat.thread || [];
      chat.model = chat.model || fallbackModel;
    }
    const pct = await fetchUsage(activeId);
    if (pct != null) chat.usagePct = pct;
  } else {
    chat.thread = [];
    chat.model = fallbackModel;
    chat.title = 'New chat';
    chat.subtitle = `0 messages · ${fallbackModel}`;
  }

  if (!chat.model) chat.model = fallbackModel;
}

// ---- actions --------------------------------------------------------------

let streamCtrl = null;       // active POST-stream controller
let renderTimer = null;      // throttle handle for stream deltas

function throttledRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    runtime.render();
  }, 60);
}

function flushRender() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  runtime.render();
}

// refresh just the active session's thread/usage from the backend
async function refreshActive(state) {
  const chat = ensureChat(state);
  const id = chat.activeId;
  if (!id) return;
  let name;
  try {
    const sessions = await apiGet('/api/sessions');
    const list = Array.isArray(sessions) ? sessions : [];
    name = list.find((s) => s.id === id)?.name;
    chat.groups = buildGroups(list, id);
  } catch (_) { /* keep existing groups */ }
  try {
    const t = await fetchThread(id, chat.model, name);
    chat.thread = t.thread;
    if (t.title) chat.title = t.title;
    chat.subtitle = t.subtitle;
    if (t.model) chat.model = t.model;
  } catch (_) { /* keep existing thread */ }
  const pct = await fetchUsage(id);
  if (pct != null) chat.usagePct = pct;
  runtime.render();
}

async function createSession(model) {
  let endpoint_url = '';
  let endpoint_id = '';
  let m = model;
  try {
    const dc = await apiGet('/api/default-chat');
    endpoint_url = dc?.endpoint_url || '';
    endpoint_id = dc?.endpoint_id || '';
    if (!m) m = dc?.model || '';
  } catch (_) { /* ignore */ }
  const res = await apiForm('/api/session', {
    name: 'New chat',
    model: m,
    endpoint_url,
    endpoint_id,
  });
  return res && res.id;
}

export const actions = {
  selectSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.activeId = id;
    if (Array.isArray(chat.groups)) {
      for (const g of chat.groups) {
        for (const r of g.rows) r.active = r.id === id;
      }
    }
    runtime.render();

    let name;
    try {
      const sessions = await apiGet('/api/sessions');
      const list = Array.isArray(sessions) ? sessions : [];
      name = list.find((s) => s.id === id)?.name;
    } catch (_) { /* ignore */ }

    try {
      const t = await fetchThread(id, chat.model, name);
      chat.thread = t.thread;
      if (t.title) chat.title = t.title;
      chat.subtitle = t.subtitle;
      if (t.model) chat.model = t.model;
    } catch (_) { /* keep prior */ }
    const pct = await fetchUsage(id);
    if (pct != null) chat.usagePct = pct;
    runtime.render();
  },

  newChat: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    chat.activeId = null;
    chat.thread = [];
    chat.title = 'New chat';
    chat.subtitle = `0 messages · ${chat.model || ''}`;
    if (Array.isArray(chat.groups)) {
      for (const g of chat.groups) for (const r of g.rows) r.active = false;
    }
    runtime.render();
  },

  send: async () => {
    const state = runtime.state;
    if (!state) return;
    const text = (state.draft || '').trim();
    if (!text) return;
    const chat = ensureChat(state);

    // ensure we have a session
    if (!chat.activeId) {
      try {
        const id = await createSession(chat.model);
        if (!id) return;
        chat.activeId = id;
      } catch (_) {
        return;
      }
    }
    const sessionId = chat.activeId;

    // optimistic user message
    if (!Array.isArray(chat.thread)) chat.thread = [];
    chat.thread.push({ role: 'user', text, time: fmtTime(Date.now()) });
    state.draft = '';
    runtime.render();

    // abort any in-flight send
    if (streamCtrl) { try { streamCtrl.abort(); } catch (_) {} streamCtrl = null; }

    let asstMsg = null;
    let got404 = false;

    const onEvent = (ev) => {
      if (!ev) return;
      if (ev.type === 'done') {
        flushRender();
        if (got404) { actions.reloadSessions(); return; }
        refreshActive(state);
        return;
      }
      if (ev.type === 'error') {
        if (ev.status === 404) got404 = true;
        return;
      }
      // streamed text delta (skip thinking)
      if (typeof ev.delta === 'string' && ev.thinking !== true) {
        if (!asstMsg) {
          asstMsg = { role: 'assistant', text: '', time: fmtTime(Date.now()), model: chat.model };
          chat.thread.push(asstMsg);
        }
        asstMsg.text += ev.delta;
        throttledRender();
      }
      // tool_start / tool_output / agent_step / metrics: not rendered in this
      // surface — ignored here; the Activity pane handles those elsewhere.
    };

    streamCtrl = postStream(
      '/api/chat_stream',
      { message: text, session: sessionId, mode: state.chatMode || 'agent' },
      onEvent,
    );
  },

  // re-fetch the session list and active thread (used after a 404 on send)
  reloadSessions: async () => {
    const state = runtime.state;
    if (!state) return;
    try {
      await load(state);
    } catch (_) { /* keep current */ }
    runtime.render();
  },
};
