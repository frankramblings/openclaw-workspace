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

// Model identity = endpoint·model. The separator (middle dot) is absent from
// endpoint ids and model names, so a plain split round-trips cleanly.
const MODEL_SEP = '·';
// Prettify a backend endpoint name for a group header: "Claude-Cli" → "Claude
// CLI", "Perplexity-Web" → "Perplexity", "ChatGPT" → "ChatGPT".
function prettyEndpoint(name) {
  return String(name || '').replace(/-web$/i, '').replace(/-cli$/i, ' CLI').replace(/-/g, ' ').trim();
}
// Strip the endpoint suffix the API bakes into model_display so rows carry only
// the bare name: "Claude Opus 4.8 (Claude CLI)" → "Claude Opus 4.8";
// "Claude Sonnet 4.6 via Perplexity (chat only)" → "Claude Sonnet 4.6".
function bareModelName(display) {
  const s = String(display || '');
  return s.replace(/\s+via\s+.*$/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim() || s;
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
  let fallbackEndpointId = '';
  try {
    const dc = await apiGet('/api/default-chat');
    fallbackModel = dc?.model || '';
    fallbackEndpointId = dc?.endpoint_id || '';
  } catch (_) { /* ignore */ }
  try {
    const cfg = await apiGet('/api/config');
    if (cfg?.workspace_root) chat.cwd = cfg.workspace_root;
  } catch (_) { /* ignore */ }

  chat.groups = buildGroups(list, activeId);
  annotateConvRows(chat);     // reflect any known working/finished dots
  startNotifier();            // begin cross-session turn polling (singleton)

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
    // Endpoint half of the model identity — the session record carries it, else
    // fall back to the default-chat endpoint. Needed so the picker's active
    // check lands on the right (endpoint·model) row, not every same-named copy.
    chat.endpointId = activeSession?.endpoint_id || fallbackEndpointId || chat.endpointId || '';
    // Re-attach to an in-flight turn after a page refresh — the live answer
    // keeps streaming instead of vanishing until the turn fully finishes.
    try { await resumeIfActive(chat, state, activeId); } catch (_) { /* non-fatal */ }
    const pct = await fetchUsage(activeId);
    if (pct != null) chat.usagePct = pct;
  } else {
    chat.thread = [];
    chat.model = fallbackModel;
    chat.endpointId = fallbackEndpointId || '';
    chat.title = 'New chat';
    chat.subtitle = `0 messages · ${fallbackModel}`;
  }

  if (!chat.model) chat.model = fallbackModel;
}

// ---- actions --------------------------------------------------------------

let streamCtrl = null;       // active POST-stream controller (fresh send)
let liveES = null;           // active EventSource tail (resume / re-attach)
let renderTimer = null;      // throttle handle for stream deltas
let elapsedTimer = null;     // ticks the "Working… Ns" elapsed clock
let turn = null;             // per-send activity state (see send())

function throttledRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    // Streaming deltas patch ONLY the active message in place (see
    // runtime.patchMessage) so we don't rebuild the whole document per token —
    // that's what killed text selection, scroll, and composer typing mid-stream.
    // Fall back to a full render if the bubble isn't mounted yet.
    if (!(turn && runtime.patchMessage && runtime.patchMessage(turn.msgId))) runtime.render();
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
      // Surgically patch ONLY the elapsed-clock text. A full runtime.render()
      // here fired every 500ms for the entire turn, rebuilding root.innerHTML —
      // which de-selected text, reset scroll, and made typing impossible. Update
      // the single text node instead; fall back to a full render only if the
      // clock isn't in the DOM yet (first tick before its initial paint).
      const el = document.querySelector('.act-elapsed');
      if (el) el.textContent = turn.activity.elapsed;
      else runtime.render();
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

// ---- live turn controller (shared by send + resume) -----------------------
// Exactly one in-flight assistant turn renders at a time, tracked in module
// `turn`. The reducer is identical whether frames arrive from POST
// /api/chat_stream (a fresh send) or from replay + the EventSource tail of
// /api/chat/stream (re-attaching to a turn still running server-side after a
// reload / thread-switch — see backend event_store + resume_route).

// Stop whichever live source is attached. Safe to call anytime: aborting the
// reader no longer stops the turn (the server-side recorder owns it), so
// switching threads / closing only detaches this client.
function stopLive() {
  if (streamCtrl) { try { streamCtrl.abort(); } catch (_) {} streamCtrl = null; }
  if (liveES) { try { liveES.close(); } catch (_) {} liveES = null; }
}

// Build a fresh per-turn reducer bound to `chat`. Returns { onEvent,
// ensureActivity }. `onEvent` is fed the same {delta|type|...} objects whether
// they came live or from replay, so a rebuilt turn looks identical to a live one.
function beginTurn(chat, modelLabel) {
  turn = { asstMsg: null, activity: null, thinkStep: null, byTid: {}, stepN: 0, msgId: 'live-' + Date.now(), got404: false };

  const ensureAsst = () => {
    if (!turn.asstMsg) {
      turn.asstMsg = { id: turn.msgId, role: 'assistant', text: '', time: fmtTime(Date.now()), model: modelLabel };
      if (!Array.isArray(chat.thread)) chat.thread = [];
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
      const hadText = turn.asstMsg && String(turn.asstMsg.text || '').trim();
      const hadWork = turn.activity && (turn.activity.steps || []).some((st) => st.kind !== 'think');
      if (!hadText && !hadWork && !turn.got404) {
        const m = ensureAsst();
        m.error = true;
        m.notice = 'No response from this model — it may not be available on your plan or endpoint. Try another model from the picker.';
      }
      flushRender();
      if (turn.got404) { actions.reloadSessions(); turn = null; return; }
      refreshSidebarUsage(runtime.state);
      turn = null;
      return;
    }
    if (ev.type === 'error') {
      if (ev.status === 404) { turn.got404 = true; return; }
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

    // reply_reset → the agent began a NEW message mid-turn (its real reply after
    // a message-tool delivery). Drop the text shown so far so the final reply
    // isn't doubled ("Sent…Hey 👋"). Tool/thinking steps are kept.
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

  return { onEvent, ensureActivity };
}

// Parse one stored SSE payload (the raw string event_store kept, e.g.
// "data: {...}\n\n" or "data: [DONE]\n\n") into a reducer event, or null.
function parseStoredSSE(raw) {
  for (const line of String(raw || '').split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') return { type: 'done' };
    try { return JSON.parse(payload); } catch (_) { return null; }
  }
  return null;
}

// Re-attach to a turn that's still running server-side for `sessionId` (the
// visible win: refresh / switch-away-and-back keeps streaming). Returns true if
// it attached. Replays the turn's events to rebuild the in-flight answer, then
// EventSource-tails the remainder from last_event_id until [DONE].
async function resumeIfActive(chat, state, sessionId) {
  if (!sessionId) return false;
  let snap;
  try {
    snap = await apiGet(`/api/chat/turn?session=${encodeURIComponent(sessionId)}`);
  } catch (_) { return false; }
  if (!snap || !snap.active) return false;
  // Guard against a thread-switch that raced this fetch.
  if (chat.activeId !== sessionId) return false;

  stopLive();
  stopElapsed();
  const { onEvent, ensureActivity } = beginTurn(chat, chat.model);
  ensureActivity();            // immediate "Working…" while we rebuild + tail
  // Continue the "Working… Ns" clock from the turn's TRUE start (server-computed
  // elapsed) instead of restarting at 0 on re-attach. Anchored to the client
  // clock via Date.now() so there's no client/server skew.
  if (typeof snap.elapsed_ms === 'number' && turn && turn.activity) {
    turn.activity.startMs = Date.now() - snap.elapsed_ms;
    turn.activity.elapsed = fmtElapsed(turn.activity.startMs);
  }
  for (const e of (snap.events || [])) {
    const ev = parseStoredSSE(e.data);
    if (ev) onEvent(ev);
  }
  flushRender();

  const cursor = snap.last_event_id || '';
  const url = `/api/chat/stream?session=${encodeURIComponent(sessionId)}` +
    (cursor ? `&last_event_id=${encodeURIComponent(cursor)}` : '');
  const es = new EventSource(location.origin + url, { withCredentials: true });
  liveES = es;
  es.onmessage = (e) => {
    if (liveES !== es) return;                 // superseded by a newer attach
    if (e.data === '[DONE]') { onEvent({ type: 'done' }); es.close(); if (liveES === es) liveES = null; return; }
    let ev = null; try { ev = JSON.parse(e.data); } catch (_) {}
    if (ev) onEvent(ev);
  };
  es.onerror = () => { /* EventSource auto-reconnects with Last-Event-ID */ };
  return true;
}

// ---- cross-session turn notifier ------------------------------------------
// Poll which sessions have a turn in flight. When one FINISHES while you're not
// viewing it, flag it (sidebar + Chats-nav dot, plus a haptic buzz) — classic-
// interface parity for "a reply landed while I was elsewhere". Cleared when you
// open that thread. Also marks still-running sessions with a 'working' dot.
let _notifyTimer = null;
let _prevActive = new Set();

function _isViewing(state, id) {
  return !!(state && state.surface === 'chat'
    && state.live && state.live.chat && state.live.chat.activeId === id);
}

// Stamp notify/working flags onto the already-built sidebar rows so a re-render
// shows the dots without rebuilding the whole list.
function annotateConvRows(chat) {
  const notified = chat.notified || new Set();
  const working = chat.activeTurns || new Set();
  for (const g of (chat.groups || [])) {
    for (const r of (g.rows || [])) {
      r.notify = notified.has(r.id) && !r.active;
      r.working = working.has(r.id) && !r.active;
    }
  }
}

async function _notifyTick() {
  const state = runtime.state;
  if (!state) return;
  let data;
  try { data = await apiGet('/api/chat/active_sessions'); } catch (_) { return; }
  const now = new Set((data && data.active) || []);
  const chat = ensureChat(state);
  chat.notified = chat.notified || new Set();
  let changed = false;

  // A session that WAS running and now isn't — and that you aren't looking at —
  // just finished while you were elsewhere: notify.
  for (const id of _prevActive) {
    if (!now.has(id) && !_isViewing(state, id) && !chat.notified.has(id)) {
      chat.notified.add(id);
      changed = true;
      try { if (navigator.vibrate) navigator.vibrate(30); } catch (_) { /* no haptics */ }
      notifyTurnDone(chat, id);   // in-app toast + OS notification (if permitted)
    }
  }
  // Re-render if the running set changed too (working dots).
  const prevWorking = chat.activeTurns || new Set();
  if (!changed && (now.size !== prevWorking.size
      || [...now].some((id) => !prevWorking.has(id)))) changed = true;

  chat.activeTurns = now;
  _prevActive = now;
  if (changed) { annotateConvRows(chat); runtime.render(); }
}

// Start the poller once (singleton). Called from load() at boot.
function startNotifier() {
  if (_notifyTimer) return;
  _notifyTimer = setInterval(_notifyTick, 4000);
  _notifyTick();
}

// --- notification surfacing (in-app toast + OS notification) ----------------
function _titleFor(chat, id) {
  for (const g of (chat.groups || [])) for (const r of (g.rows || [])) if (r.id === id) return r.title;
  return null;
}

// Switch to the chat surface and open a thread (toast / OS-notification click).
function openNotified(id) {
  const state = runtime.state;
  if (state) { state.surface = 'chat'; state.mTab = 'chat'; state.mSub = null; }
  try { if (location.hash !== '#chat') history.replaceState(null, '', '#chat'); } catch (_) {}
  actions.selectSession(id);
}

// Lazily request OS-notification permission on a user gesture (called from send).
function ensureNotifyPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch (_) { /* unsupported */ }
}

// Transient in-app toast appended to <body> (outside the render() root so it
// survives re-renders); click to open the thread, auto-dismiss after 6s.
function showChatToast(text, id) {
  try {
    let host = document.getElementById('oc-toast-host');
    if (!host) { host = document.createElement('div'); host.id = 'oc-toast-host'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = 'oc-toast';
    el.innerHTML = '<span class="oc-toast-dot"></span><span class="oc-toast-msg"></span><span class="oc-toast-go">Open</span>';
    el.querySelector('.oc-toast-msg').textContent = text;
    const close = () => { el.classList.remove('in'); setTimeout(() => el.remove(), 220); };
    el.addEventListener('click', () => { openNotified(id); close(); });
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(close, 6000);
  } catch (_) { /* DOM unavailable */ }
}

// A reply finished in a thread you weren't viewing — surface it: in-app toast
// always, plus an OS notification when the user has granted permission.
function notifyTurnDone(chat, id) {
  const title = _titleFor(chat, id) || 'a chat';
  showChatToast(`Gary finished replying · ${title}`, id);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('Gary finished replying', { body: title, tag: 'oc-turn-' + id });
      n.onclick = () => { try { window.focus(); } catch (_) {} openNotified(id); n.close(); };
    }
  } catch (_) { /* OS notifications unavailable */ }
}

export const actions = {
  selectSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    // Leaving the current thread: detach this client's live reader. The turn
    // keeps running + recording server-side, so nothing is lost — we re-attach
    // below if the thread we're opening has its own in-flight turn.
    stopLive();
    stopElapsed();
    turn = null;
    chat.rowMenuOpen = null;
    chat.activeId = id;
    if (chat.notified) chat.notified.delete(id);  // opening it clears its dot
    storeActiveId(id);
    if (Array.isArray(chat.groups)) {
      for (const g of chat.groups) {
        for (const r of g.rows) r.active = r.id === id;
      }
    }
    annotateConvRows(chat);     // refresh row dots NOW so the green one clears
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
    // Re-attach to an in-flight turn for this thread, if one is still running
    // server-side (returning to a thread you left mid-answer).
    try { await resumeIfActive(chat, state, id); } catch (_) { /* non-fatal */ }
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
        chat.endpointId = dc.endpoint_id || '';
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
    // Sending is a user gesture — a good moment to ask for OS-notification
    // permission so a reply finishing while you're elsewhere can notify you.
    ensureNotifyPermission();

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

    // Detach any prior live reader. Safe now: the server-side recorder owns the
    // turn, so aborting the reader only drops THIS client's stream.
    stopLive();
    stopElapsed();

    const { onEvent, ensureActivity } = beginTurn(chat, chat.model);
    // Immediate feedback: show the "Working…" spinner the moment we send, so the
    // model's warmup (claude-cli can take a few seconds before its first frame)
    // never looks like a dead, unresponsive turn.
    ensureActivity();
    flushRender();

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
    // Detach this client's reader AND abort the run server-side. With the
    // detached recorder, aborting the reader alone no longer stops the gateway
    // run — Stop must explicitly POST /api/chat/stop/{id} (chat.abort).
    const sid = runtime.state && ensureChat(runtime.state).activeId;
    stopLive();
    stopElapsed();
    if (sid) { apiForm(`/api/chat/stop/${sid}`, {}).catch(() => {}); }
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
    if (open && !(state.live && state.live.modelGroups)) {
      try {
        const data = await apiGet('/api/models');
        const items = (data && data.items) || [];
        const groups = [];
        const flat = [];
        for (const it of items) {
          const mids = it.models || [];
          const disp = it.models_display || it.models || [];
          const epId = it.endpoint_id || '';
          const ep = prettyEndpoint(it.endpoint_name || epId);
          const models = mids.map((mid, i) => {
            // Composite identity: the SAME model id is offered by multiple
            // endpoints (e.g. claude-sonnet-4-6 via Claude CLI AND Perplexity).
            // Key selection on endpoint·model so the copies don't co-select.
            const row = { id: epId + MODEL_SEP + mid, mid, name: bareModelName(disp[i] || mid), endpointId: epId, ep };
            flat.push(row);
            return row;
          });
          const tag = disp.some((d) => /\(chat only\)/i.test(String(d))) ? 'chat only' : '';
          groups.push({ ep, endpointId: epId, hasTag: !!tag, tag, models });
        }
        state.live = state.live || {};
        state.live.modelGroups = groups;
        state.live.modelList = flat;
        runtime.render();
      } catch (_) { /* leave the menu empty; soft-fail */ }
    }
    // Reflect the current default-for-new-chats (as a composite id) so the ★ lands
    // on exactly one row.
    if (open) {
      try {
        const dc = await apiGet('/api/default-chat');
        state.live = state.live || {};
        state.live.defaultModel = ((dc && dc.endpoint_id) || '') + MODEL_SEP + ((dc && dc.model) || '');
        runtime.render();
      } catch (_) { /* ignore */ }
    }
  },

  // ★ Set a model as the default for NEW chats (persists via POST /api/default-chat).
  // `id` is the composite endpoint·model id from the picker.
  setDefaultModel: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const item = (state.live && state.live.modelList || []).find((m) => m.id === id);
    state.live = state.live || {};
    state.live.defaultModel = id;
    runtime.render();
    try { await apiJson('/api/default-chat', { model: item ? item.mid : id, endpoint_id: item ? (item.endpointId || '') : '' }); } catch (_) {}
  },

  // Pick the chat model. `id` is the composite endpoint·model id. For a NEW chat,
  // createSession() uses chat.model/endpointId. For the ACTIVE session, PATCH the
  // record so the gateway applies it next turn (chat_stream reads it via _model_ref).
  setModel: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    const item = (state.live && state.live.modelList || []).find((m) => m.id === id);
    const mid = item ? item.mid : id;
    chat.model = mid;
    chat.endpointId = item ? item.endpointId : chat.endpointId;
    chat.subtitle = `${Array.isArray(chat.thread) ? chat.thread.length : 0} messages · ${item ? item.name : mid}`;
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
