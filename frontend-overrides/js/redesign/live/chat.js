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
import { apiGet, apiForm, apiJson, apiDelete, postStream } from './api.js';

// ---- helpers --------------------------------------------------------------

// Which conversation to reopen after a page reload. Without this the loader
// falls back to list[0] (the most-recently-touched session), so a refresh
// silently swapped you onto a different chat — the thread you were reading
// looked like it had vanished.
const ACTIVE_KEY = 'redesign.chat.activeId';
function storeActiveId(id) {
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id);
    else localStorage.removeItem(ACTIVE_KEY);
  } catch (_) { /* storage disabled → just lose the restore */ }
}
function readActiveId() {
  try { return localStorage.getItem(ACTIVE_KEY) || null; } catch (_) { return null; }
}

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
      important: !!s.important,
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
// Rebuild the Cowork-style activity trail from a turn's saved tool_events
// (backend _map_history). Skips Gary's `message` reply-delivery tool — parity
// with the live relay, which hides its card — so reload matches the live view.
function historySteps(toolEvents, msgIdx) {
  if (!Array.isArray(toolEvents)) return [];
  const steps = [];
  toolEvents.forEach((ev, i) => {
    const name = String(ev.tool || '');
    if (/^(message|mcp__openclaw__message)$/i.test(name)) return;
    const kind = toolKind(name);
    const failed = ev.exit_code != null && ev.exit_code !== 0;
    const lines = String(ev.output || '').split('\n').filter((l) => l.length)
      .slice(0, 200).map((t) => ({ t, c: lineColor(t) }));
    steps.push({
      id: `h${msgIdx}-s${i}`,
      kind,
      label: PAST[kind] || 'Ran',
      file: ev.command || '',
      meta: failed ? `exit ${ev.exit_code}` : '',
      metaColor: failed ? 'var(--red)' : undefined,
      state: failed ? 'error' : 'done',
      lines,
    });
  });
  return steps;
}

async function fetchThread(id, fallbackModel, name) {
  const hist = await apiGet(`/api/history/${id}?limit=100`);
  const list = Array.isArray(hist?.history) ? hist.history : [];
  const model = hist?.model || fallbackModel || '';
  const thread = list.map((h, i) => {
    const meta = h?.metadata || {};
    const msg = {
      id: `h${i}`,
      role: h.role === 'user' ? 'user' : 'assistant',
      text: h.content || '',
      time: fmtTime(meta.timestamp),
      model: meta.model || model,
    };
    if (msg.role === 'assistant') {
      const steps = historySteps(meta.tool_events, i);
      if (steps.length) {
        // The final answer is the LAST non-empty round (backend `content` is the
        // first); render it below the trail, like the live multi-round view.
        const rts = Array.isArray(meta.round_texts)
          ? meta.round_texts.filter((t) => t && t.trim()) : [];
        if (rts.length) msg.text = rts[rts.length - 1];
        msg.activity = {
          status: 'done',
          worked: `Worked · ${steps.length} step${steps.length === 1 ? '' : 's'}`,
          steps,
        };
      }
    }
    return msg;
  });
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
  // Prefer the in-memory active chat, then the one persisted from last session
  // (if it still exists), and only then fall back to the most-recent session.
  const stored = readActiveId();
  const storedValid = stored && list.some((s) => s.id === stored);
  const activeId = chat.activeId || (storedValid ? stored : null)
    || (list[0] && list[0].id) || null;
  chat.activeId = activeId;
  storeActiveId(activeId);

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
    storeActiveId(id);
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
    if (Array.isArray(chat.groups)) {
      for (const g of chat.groups) for (const r of g.rows) r.active = false;
    }
    chat.subtitle = `0 messages · ${chat.model || ''}`;
    runtime.render();
    // A new chat should start on the persisted default model, not whatever the
    // last-opened conversation happened to use. Fetch it and re-render if it
    // differs (createSession() on first send then carries this model).
    apiGet('/api/default-chat').then((dc) => {
      if (dc && dc.model && dc.model !== chat.model && !chat.activeId) {
        chat.model = dc.model;
        chat.subtitle = `0 messages · ${chat.model || ''}`;
        runtime.render();
      }
    }).catch(() => { /* keep current model */ });
  },

  send: async () => {
    const state = runtime.state;
    if (!state) return;
    const text = (state.draft || '').trim();
    const attachIds = (state.pendingAttach || []).map((a) => a.id);
    if (!text && !attachIds.length) return;
    const chat = ensureChat(state);

    // ensure we have a session
    if (!chat.activeId) {
      try {
        const id = await createSession(chat.model);
        if (!id) return;
        chat.activeId = id;
        storeActiveId(id);
      } catch (_) {
        return;
      }
    }
    const sessionId = chat.activeId;

    // optimistic user message
    if (!Array.isArray(chat.thread)) chat.thread = [];
    chat.thread.push({ id: 'live-u-' + Date.now(), role: 'user', text, time: fmtTime(Date.now()) });
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

    // Immediate feedback: show the "Working…" spinner the moment we send, so the
    // model's warmup (claude-cli can take a few seconds before its first frame)
    // never looks like a dead, unresponsive turn.
    ensureActivity();
    flushRender();

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
        // Empty-turn safeguard: the turn ended with no assistant text and no
        // tool work (e.g. the model isn't served on this plan/endpoint, so the
        // gateway streamed an empty reply). Surface that instead of a blank.
        const hadText = turn.asstMsg && String(turn.asstMsg.text || '').trim();
        const hadWork = turn.activity && (turn.activity.steps || []).some((st) => st.kind !== 'think');
        if (!hadText && !hadWork && !turn.got404) {
          const m = ensureAsst();
          m.error = true;
          m.notice = 'No response from this model — it may not be available on your plan or endpoint. Try another model from the picker.';
        }
        flushRender();
        if (turn.got404) { actions.reloadSessions(); turn = null; return; }
        refreshSidebarUsage(state);
        turn = null;
        return;
      }
      if (ev.type === 'error') {
        if (ev.status === 404) { turn.got404 = true; return; }
        // Non-404 failure (the stream never opened, or dropped): show why rather
        // than leaving the user staring at their own message with no reply.
        const m = ensureAsst();
        m.error = true;
        m.notice = ev.status
          ? `Couldn’t get a response (HTTP ${ev.status}). Try again, or pick another model.`
          : 'The connection dropped before a response arrived. Try again.';
        stopElapsed();
        flushRender();
        turn = null;
        return;
      }

      // reply_reset → the agent began a NEW message mid-turn (its real reply
      // after a message-tool delivery). Drop the text shown so far so the final
      // reply isn't doubled ("Sent…Hey 👋"). Tool/thinking steps are kept.
      if (ev.type === 'reply_reset') {
        if (turn.asstMsg) turn.asstMsg.text = '';
        throttledRender();
        return;
      }

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
      {
        message: text,
        session: sessionId,
        mode: state.chatMode || 'agent',
        ...(attachIds.length ? { attachments: JSON.stringify(attachIds) } : {}),
        ...(state.incognito ? { incognito: 'true' } : {}),
      },
      onEvent,
    );
    state.pendingAttach = []; // consumed by this turn
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

  // Composer model picker: open/close the menu, lazily loading the catalog
  // from /api/models (items → flattened {mid, name}).
  toggleModelMenu: async () => {
    const state = runtime.state;
    if (!state) return;
    const open = !state.modelMenuOpen;
    state.modelMenuOpen = open;
    runtime.render();
    if (open && !(state.live && state.live.modelList)) {
      try {
        const data = await apiGet('/api/models');
        const items = (data && data.items) || [];
        const list = [];
        for (const it of items) {
          const mids = it.models || [];
          const disp = it.models_display || it.models || [];
          mids.forEach((mid, i) => list.push({ mid, name: disp[i] || mid, ep: it.endpoint_name, endpointId: it.endpoint_id }));
        }
        state.live = state.live || {};
        state.live.modelList = list;
        runtime.render();
      } catch (_) { /* leave the menu empty; soft-fail */ }
    }
    // Reflect the current default-for-new-chats so the ★ shows correctly.
    if (open) {
      try {
        const dc = await apiGet('/api/default-chat');
        state.live = state.live || {};
        state.live.defaultModel = dc && dc.model;
        runtime.render();
      } catch (_) { /* ignore */ }
    }
  },

  // ★ Set a model as the default for NEW chats (persists via POST /api/default-chat).
  setDefaultModel: async (mid) => {
    const state = runtime.state;
    if (!state || !mid) return;
    const item = (state.live && state.live.modelList || []).find((m) => m.mid === mid);
    state.live = state.live || {};
    state.live.defaultModel = mid;
    runtime.render();
    try { await apiJson('/api/default-chat', { model: mid, endpoint_id: item ? (item.endpointId || '') : '' }); } catch (_) {}
  },

  // Pick the chat model. For a NEW chat, createSession() uses it. For the ACTIVE
  // session, PATCH the session record so the gateway applies it on the next turn
  // (chat_stream reads the session's model via _model_ref — backend already wired).
  setModel: (mid) => {
    const state = runtime.state;
    if (!state || !mid) return;
    const chat = ensureChat(state);
    chat.model = mid;
    const item = (state.live && state.live.modelList || []).find((m) => m.mid === mid);
    chat.endpointId = item ? item.endpointId : chat.endpointId;
    chat.subtitle = `${Array.isArray(chat.thread) ? chat.thread.length : 0} messages · ${mid}`;
    state.modelMenuOpen = false;
    runtime.render();
    if (chat.activeId) {
      const fields = { model: mid };
      if (chat.endpointId) fields.endpoint_id = chat.endpointId;
      apiForm(`/api/session/${chat.activeId}`, fields, { method: 'PATCH' }).catch(() => {});
    }
  },

  // Composer attach: upload picked files, keep ids as pending chips; send()
  // carries them on the next turn. Called directly by the file-input change
  // listener (app.js) with a FileList.
  uploadAttachments: async (files) => {
    const state = runtime.state;
    if (!state || !files || !files.length) return;
    const fd = new FormData();
    for (const f of files) fd.append('files', f, f.name || 'upload');
    try {
      const res = await fetch(`${location.origin}/api/upload`, { method: 'POST', credentials: 'same-origin', body: fd });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      const saved = (data && data.files) || [];
      state.pendingAttach = [...(state.pendingAttach || []), ...saved.map((s) => ({ id: s.id, name: s.name }))];
      runtime.render();
    } catch (_) { /* soft-fail: nothing attached */ }
  },

  // Remove a pending attachment chip before sending.
  removeAttach: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    state.pendingAttach = (state.pendingAttach || []).filter((a) => a.id !== id);
    runtime.render();
  },

  // Chat-header "More" menu: open/close + per-conversation actions.
  toggleChatMenu: () => {
    const state = runtime.state;
    if (!state) return;
    state.chatMenuOpen = !state.chatMenuOpen;
    runtime.render();
  },
  // Rename the active conversation → PATCH /api/session/{id} (FormData name).
  renameSession: async (id) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    state.chatMenuOpen = false;
    chat.rowMenuOpen = null;
    const target = id || chat.activeId;
    if (!target) { runtime.render(); return; }
    let cur = chat.title || '';
    if (target !== chat.activeId) {
      const rows = (chat.groups || []).flatMap((g) => g.rows || []);
      cur = (rows.find((r) => r.id === target) || {}).title || '';
    }
    let name = null;
    try { name = window.prompt('Rename conversation', cur); } catch (_) { name = null; }
    if (name == null) { runtime.render(); return; }
    name = name.trim();
    if (!name) { runtime.render(); return; }
    if (target === chat.activeId) chat.title = name;
    runtime.render();
    try { await apiForm(`/api/session/${target}`, { name }, { method: 'PATCH' }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },
  // Copy the transcript to the clipboard.
  copyTranscript: async (id) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    state.chatMenuOpen = false;
    chat.rowMenuOpen = null;
    let thread = chat.thread || [];
    if (id && id !== chat.activeId) {
      try {
        const hist = await apiGet(`/api/history/${id}?limit=200`);
        const list = Array.isArray(hist?.history) ? hist.history : [];
        thread = list.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', text: h.content || '' }));
      } catch (_) { thread = []; }
    }
    const text = thread.map((m) => `${m.role === 'user' ? 'You' : 'Gary'}: ${m.text || ''}`).join('\n\n');
    try { await navigator.clipboard.writeText(text); } catch (_) {}
    runtime.render();
  },
  // Export the transcript as a downloaded Markdown file (client-side).
  exportChat: () => {
    const state = runtime.state;
    if (!state) return;
    state.chatMenuOpen = false;
    const chat = ensureChat(state);
    const title = chat.title || 'conversation';
    const md = `# ${title}\n\n` + (chat.thread || []).map((m) => `**${m.role === 'user' ? 'You' : 'Gary'}:** ${m.text || ''}`).join('\n\n');
    try {
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${title.replace(/[^\w.-]+/g, '_')}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) {}
    runtime.render();
  },

  // Session list: archive a conversation → POST /api/session/{id}/archive.
  archiveSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const wasActive = chat.activeId === id;
    try { await apiJson(`/api/session/${id}/archive`, {}); } catch (_) {}
    if (wasActive) { chat.activeId = null; storeActiveId(null); chat.thread = []; chat.title = 'New chat'; chat.subtitle = ''; }
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Session list: delete a conversation (confirm-guarded) → DELETE /api/session/{id}.
  deleteSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    let ok = false;
    try { ok = window.confirm('Delete this conversation? This cannot be undone.'); } catch (_) { ok = false; }
    if (!ok) return;
    const chat = ensureChat(state);
    const wasActive = chat.activeId === id;
    try { await apiDelete(`/api/session/${id}`); } catch (_) {}
    if (wasActive) { chat.activeId = null; storeActiveId(null); chat.thread = []; chat.title = 'New chat'; chat.subtitle = ''; }
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Sidebar: open/close a single row's actions menu.
  toggleConvMenu: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = chat.rowMenuOpen === id ? null : id;
    state.chatMenuOpen = false;
    runtime.render();
  },

  // Sidebar: toggle a conversation's favorite flag → POST /api/session/{id}/important.
  toggleFavorite: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
    const rows = (chat.groups || []).flatMap((g) => g.rows || []);
    const row = rows.find((r) => r.id === id);
    const next = !(row && row.important);
    if (row) row.important = next; // optimistic
    runtime.render();
    try { await apiForm(`/api/session/${id}/important`, { important: String(next) }); } catch (_) {}
    try { await load(state); } catch (_) {}
    runtime.render();
  },

  // Message toolbar: copy one message's text to the clipboard.
  copyMessage: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) return;
    try { await navigator.clipboard.writeText(msg.text); } catch (_) {}
  },

  // Message toolbar: download one message's text as a .md file (client-side).
  downloadMessage: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) return;
    const who = msg.role === 'user' ? 'you' : 'gary';
    const slug = (msg.text.split('\n')[0] || 'message').slice(0, 40).replace(/[^\w.-]+/g, '_');
    try {
      const blob = new Blob([msg.text], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `${who}-${slug}.md`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    } catch (_) {}
  },

  // Swallow clicks on menu chrome so they neither select the row nor close the menu.
  noop: () => {},
};
