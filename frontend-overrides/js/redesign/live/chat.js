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
let elapsedTimer = null;     // ticks the "Working… Ns" elapsed clock
let turn = null;             // per-send activity state (see send())

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

// ---- activity-trail mapping (live SSE → step model) -----------------------
// Map a tool name to a step kind; present/past-tense labels per state.
function toolKind(name) {
  const n = String(name || '').toLowerCase();
  if (/grep|search|find|\brg\b|glob|ripgrep/.test(n)) return 'grep';
  if (/web|fetch|browse|http|url|google/.test(n)) return 'web';
  if (/read|cat|open|view|get_file|load/.test(n)) return 'read';
  if (/edit|write|patch|str_replace|create|apply|insert|append/.test(n)) return 'edit';
  if (/bash|shell|run|exec|terminal|command|npm|sh\b/.test(n)) return 'run';
  return 'generic';
}
const PRESENT = { read: 'Reading', grep: 'Searching', edit: 'Editing', run: 'Running', web: 'Searching the web', generic: 'Working' };
const PAST = { read: 'Read', grep: 'Searched', edit: 'Edited', run: 'Ran', web: 'Searched the web', generic: 'Ran tool' };

function fmtElapsed(ms) { return `${Math.max(0, Math.round((Date.now() - ms) / 1000))}s`; }

function lineColor(line) {
  const t = String(line).trim();
  if (t.startsWith('✓')) return 'var(--green)';
  if (/\b(error|fatal|failed|exception)\b/i.test(t)) return 'var(--red)';
  if (t.startsWith('#') || t.startsWith('//')) return 'var(--faint)';
  return '#cfd3da';
}

function stopElapsed() { if (elapsedTimer) { clearInterval(elapsedTimer); elapsedTimer = null; } }
function startElapsed() {
  stopElapsed();
  elapsedTimer = setInterval(() => {
    if (turn && turn.activity && turn.activity.status === 'working') {
      turn.activity.elapsed = fmtElapsed(turn.activity.startMs);
      runtime.render();
    } else stopElapsed();
  }, 500);
}

function finalizeStep(st) {
  if (!st || st.state !== 'running') return;
  st.state = 'done';
  st.cursor = false;
  if (st.kind === 'think') {
    st.label = `Thought for ${Math.max(1, Math.round((Date.now() - st.startMs) / 1000))}s`;
  } else {
    st.label = PAST[st.kind] || 'Ran tool';
    if (st.kind === 'run' && !st.meta) {
      st.meta = `✓ ${((Date.now() - st.startMs) / 1000).toFixed(1)}s`;
      st.metaColor = 'var(--green)';
    }
  }
}
function finalizeTools(a) { if (a) for (const st of a.steps) if (st.kind !== 'think') finalizeStep(st); }
function finalizeAll(a) { if (a) for (const st of a.steps) finalizeStep(st); }

// after a turn completes, refresh the sidebar + usage but KEEP the optimistic
// thread (it carries the live activity trail, which history doesn't store).
async function refreshSidebarUsage(state) {
  const chat = ensureChat(state);
  const id = chat.activeId;
  try {
    const sessions = await apiGet('/api/sessions');
    const list = Array.isArray(sessions) ? sessions : [];
    chat.groups = buildGroups(list, id);
    const name = list.find((s) => s.id === id)?.name;
    if (name) chat.title = name;
  } catch (_) { /* keep */ }
  if (Array.isArray(chat.thread)) chat.subtitle = `${chat.thread.length} messages · ${chat.model || ''}`;
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
    stopElapsed();

    // per-turn activity state — an assistant message that accrues the trail
    turn = { asstMsg: null, activity: null, thinkStep: null, byTid: {}, stepN: 0, msgId: 'live-' + Date.now(), got404: false };

    const ensureAsst = () => {
      if (!turn.asstMsg) {
        turn.asstMsg = { id: turn.msgId, role: 'assistant', text: '', time: fmtTime(Date.now()), model: chat.model };
        chat.thread.push(turn.asstMsg);
      }
      return turn.asstMsg;
    };
    const ensureActivity = () => {
      ensureAsst();
      if (!turn.asstMsg.activity) {
        turn.asstMsg.activity = { status: 'working', steps: [], startMs: Date.now(), elapsed: '0s' };
        turn.activity = turn.asstMsg.activity;
        startElapsed();
      }
      return turn.asstMsg.activity;
    };
    const newStep = (kind, file, tid) => {
      const a = ensureActivity();
      const st = { id: `${turn.msgId}-s${turn.stepN++}`, kind, label: PRESENT[kind] || 'Working', file: file || '', state: 'running', lines: [], startMs: Date.now() };
      if (kind === 'think') st.label = 'Thinking';
      a.steps.push(st);
      if (tid != null) turn.byTid[tid] = st;
      return st;
    };

    const onEvent = (ev) => {
      if (!ev) return;

      if (ev.type === 'done') {
        if (turn.thinkStep) finalizeStep(turn.thinkStep);
        const a = turn.activity;
        if (a) {
          finalizeAll(a);
          a.status = 'done';
          a.elapsed = fmtElapsed(a.startMs);
          a.worked = `Worked for ${a.elapsed} · ${a.steps.length} steps`;
        }
        stopElapsed();
        flushRender();
        if (turn.got404) { actions.reloadSessions(); turn = null; return; }
        refreshSidebarUsage(state);
        turn = null;
        return;
      }
      if (ev.type === 'error') { if (ev.status === 404) turn.got404 = true; return; }

      // thinking delta → a 'think' step whose body is the reasoning
      if (typeof ev.delta === 'string' && ev.thinking === true) {
        ensureActivity();
        if (!turn.thinkStep || turn.thinkStep.state !== 'running') turn.thinkStep = newStep('think');
        turn.thinkStep.body = (turn.thinkStep.body || '') + ev.delta;
        throttledRender();
        return;
      }
      // prose delta → the assistant's answer (tools/thinking are done by now)
      if (typeof ev.delta === 'string') {
        if (turn.thinkStep) finalizeStep(turn.thinkStep);
        if (turn.activity) finalizeTools(turn.activity);
        ensureAsst();
        turn.asstMsg.text += ev.delta;
        throttledRender();
        return;
      }
      // tool start → a running tool step (prior running tools check off)
      if (ev.type === 'tool_start') {
        if (turn.thinkStep) finalizeStep(turn.thinkStep);
        if (turn.activity) finalizeTools(turn.activity);
        const kind = toolKind(ev.tool);
        const st = newStep(kind, ev.command || ev.file || ev.path || ev.tool || '', ev.tool_id);
        st.cursor = true;
        throttledRender();
        return;
      }
      // tool output → append to the step's detail; exit_code finalizes it
      if (ev.type === 'tool_output') {
        let st = (ev.tool_id != null && turn.byTid[ev.tool_id]);
        if (!st) { for (let i = (turn.activity?.steps.length || 0) - 1; i >= 0; i--) { const c = turn.activity.steps[i]; if (c.kind !== 'think' && c.state === 'running') { st = c; break; } } }
        if (st) {
          if (typeof ev.output === 'string' && ev.output) {
            for (const line of ev.output.split('\n')) st.lines.push({ t: line, c: lineColor(line) });
          }
          if (ev.exit_code != null) {
            if (ev.exit_code !== 0) { st.meta = `exit ${ev.exit_code}`; st.metaColor = 'var(--red)'; }
            finalizeStep(st);
            if (ev.exit_code !== 0) st.state = 'error';
          }
          throttledRender();
        }
        return;
      }
      // agent_step / metrics / run_alive / stall: ignored
    };

    streamCtrl = postStream(
      '/api/chat_stream',
      { message: text, session: sessionId, mode: state.chatMode || 'agent' },
      onEvent,
    );
  },

  stopRun: () => {
    if (streamCtrl) { try { streamCtrl.abort(); } catch (_) {} streamCtrl = null; }
    stopElapsed();
    if (turn && turn.activity) {
      const a = turn.activity;
      finalizeAll(a);
      a.status = 'done';
      a.elapsed = fmtElapsed(a.startMs);
      a.worked = `Stopped after ${a.elapsed} · ${a.steps.length} steps`;
    }
    turn = null;
    runtime.render();
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
