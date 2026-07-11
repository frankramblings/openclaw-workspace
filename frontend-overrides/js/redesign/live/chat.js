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
import { renderMarkdown } from '../markdown.js';
import { AVATAR } from '../data.js';
import { reconcileDecision } from './reconcile-decision.js';
import { promiseWarningText, latestAsstAtOrBefore } from './promise-warning.js';
import { setLiveTurn } from './turn-ref.js';
import {
  initStripState, stripReducer, onTurnDone as stripOnTurnDone,
  onUserSend as stripOnUserSend, onSessionSwitch as stripOnSessionSwitch,
  toggleCollapsed as stripToggleCollapsed, readCollapsed as stripReadCollapsed,
  sweepAgents as stripSweepAgents, renderChatStrip,
} from '../chat-strip.js';

// The throttled per-token render only patches the active message bubble in
// place — it does NOT re-render `.composer-wrap`, which is where the strip
// lives. So each reducer mutation needs its own targeted DOM patch or nothing
// visible changes until the next full render (which may never come during a
// long tool-heavy turn). This finds the existing `.chat-strip` and swaps its
// outerHTML for the freshly-rendered version; if none exists yet (idle → first
// tool event), it inserts the new one at the top of `.composer-wrap`. Empty
// strip → remove the node entirely so nothing lingers when idle.
function patchChatStrip(chat) {
  if (!chat) return;
  persistStripToServer(chat.activeId, chat.chatStrip);
  try {
    // Desktop: .composer-wrap (strip is first child, above .composer).
    // Mobile: .m-composer (strip is first child, above .bar).
    const wrap = document.querySelector('.composer-wrap') || document.querySelector('.m-composer');
    if (!wrap) return;
    const html = renderChatStrip(chat.chatStrip, { renderMarkdown });
    const existing = wrap.querySelector(':scope > .chat-strip');
    if (!html) { if (existing) existing.remove(); return; }
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const fresh = tmp.firstElementChild;
    if (!fresh) { if (existing) existing.remove(); return; }
    if (existing) existing.replaceWith(fresh);
    else wrap.insertBefore(fresh, wrap.firstChild);
  } catch (_) { /* fall back to next full render */ }
}

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

const _MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE',
  'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

// Date bucket label for a session. Recent conversations get named buckets;
// anything older than "last week" is grouped by month so the full history
// stays reachable by scrolling (no hard cap — see buildGroups).
function bucketFor(updated, now) {
  const today = startOfDay(now);
  const yesterday = today - 86400000;
  // Week starts Monday, local time.
  const dow = (new Date(now).getDay() + 6) % 7;
  const weekStart = today - dow * 86400000;
  const lastWeekStart = weekStart - 7 * 86400000;
  const u = startOfDay(updated || 0);
  if (u >= today) return 'TODAY';
  if (u >= yesterday) return 'YESTERDAY';
  if (u >= weekStart) return 'THIS WEEK';
  if (u >= lastWeekStart) return 'LAST WEEK';
  const d = new Date(updated || 0);
  const yr = d.getFullYear();
  return yr === new Date(now).getFullYear()
    ? _MONTHS[d.getMonth()]
    : `${_MONTHS[d.getMonth()]} ${yr}`;
}

// Build the sidebar conversation groups from the FULL session list. Favorites
// float to a ★ PINNED group; everything else is date-bucketed. There is no
// item cap — all (non-archived) sessions render, and .conv-scroll scrolls the
// whole history. Sessions arrive newest-first, so Map insertion order yields
// TODAY → YESTERDAY → THIS WEEK → LAST WEEK → months (newest → oldest).
function buildGroups(sessions, activeId) {
  const now = Date.now();
  const pinned = [];
  const byLabel = new Map();
  // Sort newest-activity first (the API sorts by `created`, but recency of the
  // last message is what the date buckets and row order should reflect).
  const ordered = [...sessions].sort(
    (a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0));
  for (const s of ordered) {
    if (s.archived) continue;
    const row = {
      id: s.id,
      title: s.name || 'New chat',
      term: !!s.gary_terminal,
      active: s.id === activeId,
      important: !!s.important,
      model: s.model || '',
      endpointId: s.endpoint_id || '',
    };
    if (s.important) { pinned.push(row); continue; }
    const label = bucketFor(s.updated, now);
    if (!byLabel.has(label)) byLabel.set(label, []);
    byLabel.get(label).push(row);
  }
  const groups = [];
  if (pinned.length) groups.push({ label: '★ PINNED', rows: pinned });
  for (const [label, rows] of byLabel) groups.push({ label, rows });
  return groups;
}

function round1(n) {
  if (n == null || isNaN(n)) return null;
  return Math.round(n * 10) / 10;
}

// One pending timer per chat is enough — the next-earliest clearAt wins.
function scheduleStripSweep(chat) {
  if (!chat || !chat.chatStrip) return;
  const now = Date.now();
  let earliest = Infinity;
  for (const id in chat.chatStrip.agents) {
    const a = chat.chatStrip.agents[id];
    if (a.clearAt != null && a.clearAt < earliest) earliest = a.clearAt;
  }
  if (!Number.isFinite(earliest)) return;
  const delay = Math.max(0, earliest - now) + 50;
  if (chat._stripSweepTimer) clearTimeout(chat._stripSweepTimer);
  chat._stripSweepTimer = setTimeout(() => {
    chat._stripSweepTimer = null;
    const before = chat.chatStrip;
    chat.chatStrip = stripSweepAgents(chat.chatStrip, Date.now());
    if (chat.chatStrip !== before) runtime.render();
    scheduleStripSweep(chat);
  }, delay);
}

function ensureChat(state) {
  if (!state.live) state.live = {};
  if (!state.live.chat) state.live.chat = {};
  if (!state.live.chat.chatStrip) {
    state.live.chat.chatStrip = initStripState();
    try { state.live.chat.chatStrip.collapsed = stripReadCollapsed(window.localStorage); } catch (_) {}
  }
  if (!state.live.chat.chatStripByKey) state.live.chat.chatStripByKey = {};
  return state.live.chat;
}

// Task 0b: preserve the strip across thread switches so background TaskCreate
// items (subagents, followups, cron) stay visible when the user peeks at another
// thread and returns. Keyed by session id; new-chat strips (no id yet) don't
// persist. B-tier fix (server-side per-turn persistence) tracked separately.
function saveStripForCurrent(chat) {
  if (!chat || !chat.chatStripByKey) return;
  const key = chat.activeId;
  if (!key) return;
  if (chat.chatStrip) chat.chatStripByKey[key] = chat.chatStrip;
}
function loadStripForKey(chat, id) {
  const cached = id && chat.chatStripByKey ? chat.chatStripByKey[id] : null;
  if (cached) return cached;
  const fresh = initStripState();
  try { fresh.collapsed = stripReadCollapsed(window.localStorage); } catch (_) {}
  return fresh;
}

// Fetch + map history into a thread; returns { thread, title?, subtitle, model }.
// Rebuild the Cowork-style activity trail from a turn's saved tool_events
// (backend _map_history). Skips the agent's `message` reply-delivery tool — parity
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
      round: ev.round || 1,
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
    // Backend rewrites followup seeds to a compact ⚙️ line; render as a
    // centered system card, not a user bubble (surfaces.js chatMsg).
    if (msg.role === 'user' && /^⚙️ Background task/.test(msg.text)) msg.sys = true;
    // Image attachments persisted by the backend sidecar (the gateway transcript
    // only keeps text) → rehydrate so sent images survive a refresh.
    if (Array.isArray(h.attachments) && h.attachments.length) {
      msg.attach = h.attachments.map((a) => ({ id: a.id, name: a.name || a.id, url: a.url }));
    }
    if (msg.role === 'assistant') {
      // Preserve raw epoch-ms timestamp for pending-work hydration matching.
      if (meta.timestamp != null) msg._ts = Number(meta.timestamp);
      const steps = historySteps(meta.tool_events, i);
      if (steps.length) {
        // The final answer is the LAST non-empty round (backend `content` is the
        // first); render it below the trail, like the live multi-round view.
        const rawRts = Array.isArray(meta.round_texts) ? meta.round_texts : [];
        const rts = rawRts.filter((t) => t && t.trim());
        if (rts.length) msg.text = rts[rts.length - 1];
        // Keep the full (unfiltered) round array for interleaved rendering in
        // chatMsg — indices must line up with tool_event round numbers.
        if (rawRts.length > 1) msg.round_texts = rawRts;
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

// Hydrate resolved update_blocks from the server into thread messages so
// generated images etc. survive a session-switch or page refresh.
//
// Calls /api/pending/hydrate for the session (no turn_ids — returns all turns
// with any stored data). For each turn's update_blocks, finds the best-matching
// assistant message by _ts proximity to spawned_at, then populates
// msg.updateBlocks so the render path shows the resolved content.
//
// Only runs for sessions with _ts on at least one assistant message (requires
// the server to have emitted metadata.timestamp for the turn). Non-fatal.
async function hydrateThread(sessionId, thread) {
  if (!sessionId || !Array.isArray(thread)) return;
  let hydration;
  try {
    hydration = await apiGet(`/api/pending/hydrate?session=${encodeURIComponent(sessionId)}`);
  } catch (_) { return; }
  if (!hydration || typeof hydration !== 'object') return;

  // Collect turns that have update_blocks to apply.
  const turns = Object.entries(hydration)
    .map(([tid, d]) => ({
      turnId: Number(tid),
      updateBlocks: Array.isArray(d.update_blocks) ? d.update_blocks : [],
      pendingTokens: Array.isArray(d.pending_tokens) ? d.pending_tokens : [],
    }))
    .filter((t) => t.updateBlocks.length > 0 || t.pendingTokens.length > 0);

  if (!turns.length) return;

  // Build a list of assistant messages with raw timestamps for matching.
  const asstMsgs = thread.filter((m) => m.role === 'assistant' && m._ts != null);
  if (!asstMsgs.length) return;

  // For each turn, pick the best-matching assistant message: the one whose
  // _ts is closest to (but ≤) the first update_block's spawned_at epoch-ms.
  // Falls back to the last assistant message if no timestamp proximity works.
  for (const t of turns) {
    if (!t.updateBlocks.length) continue;
    const spawnedIso = t.updateBlocks[0].spawned_at;
    const spawnedMs = spawnedIso ? Date.parse(spawnedIso) : NaN;
    let best = asstMsgs[asstMsgs.length - 1];
    if (!isNaN(spawnedMs)) {
      // Latest assistant message whose _ts ≤ spawned_at (the turn that owned this work).
      for (const m of asstMsgs) {
        if (m._ts <= spawnedMs) best = m;
      }
    }
    if (!best.updateBlocks || !best.updateBlocks.length) {
      best.updateBlocks = t.updateBlocks.map((b) => ({ payload: b.payload || {}, elapsed_ms: b.elapsed_ms || 0 }));
    }
  }
}

// Re-attach persisted empty-promise warnings after a reload (the live
// promise_warning frame only reaches clients attached to the stream).
async function hydrateWarnings(sessionId, thread) {
  if (!sessionId || !Array.isArray(thread)) return;
  let res;
  try {
    res = await apiGet(`/api/promise/warnings?session=${encodeURIComponent(sessionId)}`);
  } catch (_) { return; }
  const warnings = (res && Array.isArray(res.warnings)) ? res.warnings : [];
  if (!warnings.length) return;
  const asstMsgs = thread.filter((m) => m.role === 'assistant' && m._ts != null);
  for (const w of warnings) {
    const best = latestAsstAtOrBefore(asstMsgs, w.ts);
    if (best && !best.warnNotice && !best.error) {
      best.warnNotice = promiseWarningText(w.phrase || '');
    }
  }
}

// ---- load -----------------------------------------------------------------

export async function load(state) {
  // sessions list — if this throws, loader keeps the mock.
  const sessions = await apiGet('/api/sessions');
  const list = Array.isArray(sessions) ? sessions : [];

  const chat = ensureChat(state);
  // Restore the session from before the reload. storeActiveId(null) is called
  // when the user explicitly leaves a chat (New Chat, delete), so a null stored
  // value correctly keeps the welcome screen after refresh in those cases.
  const stored = readActiveId();
  const storedValid = stored && list.some((s) => s.id === stored);
  const activeId = chat.activeId || (storedValid ? stored : null) || null;
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
      runtime.wantChatBottom = true;   // land on the latest message after refresh
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
    try { await reconcileTurn(chat, state, activeId); } catch (_) { /* non-fatal */ }
    // Populate resolved update_blocks (generated images etc.) that the frontend
    // missed while away — survives page refresh and session switch.
    try { await hydrateThread(activeId, chat.thread); } catch (_) { /* non-fatal */ }
    try { await hydrateWarnings(activeId, chat.thread); } catch (_) { /* non-fatal */ }
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
let _notifyResuming = null;  // session id with a notifier-driven resume in flight
let _stripPersistTimer = null;

// Debounced (500ms) write of the strip's todo items to the server so they
// survive a full PWA reload. sessionId is chat.activeId (the 12-hex session
// id). Sends an empty array when todos have been cleared — that keeps the
// server in sync without needing a separate clear call on every completion.
function persistStripToServer(sessionId, strip) {
  if (!sessionId) return;
  if (_stripPersistTimer) clearTimeout(_stripPersistTimer);
  _stripPersistTimer = setTimeout(async () => {
    _stripPersistTimer = null;
    const tasks = (strip && strip.todos && strip.todos.items) ? strip.todos.items : [];
    try {
      const fd = new FormData();
      fd.append('session', sessionId);
      fd.append('tasks_json', JSON.stringify(tasks));
      await fetch('/api/strip/state', { method: 'POST', credentials: 'same-origin', body: fd });
    } catch (_) { /* non-fatal */ }
  }, 500);
}

// Pending-work token state: maps backend turn_id (int) → message object.
// Persists across turn teardown so token.resolved frames that arrive after
// `turn = null` can still find and patch their originating message.
const _pendingByTurnId = new Map();

function _handlePendingFrame(ev, chat) {
  const turnId = ev.turn_id;
  if (turnId == null) return;
  if (ev.type === 'token.added') {
    let msg = _pendingByTurnId.get(turnId);
    if (!msg && turn && turn.asstMsg) {
      // First token.added for this turn: associate with the live message.
      msg = turn.asstMsg;
      _pendingByTurnId.set(turnId, msg);
    }
    if (!msg) return;
    msg.pendingTokens = msg.pendingTokens || [];
    msg.pendingTokens.push(ev.token);
    if (!(runtime.patchMessage && runtime.patchMessage(msg.id))) runtime.render();
  } else if (ev.type === 'token.resolved') {
    const msg = _pendingByTurnId.get(turnId);
    if (!msg) return;
    msg.pendingTokens = (msg.pendingTokens || []).filter((t) => t.id !== ev.token_id);
    msg.updateBlocks = msg.updateBlocks || [];
    msg.updateBlocks.push({ payload: ev.payload || {}, elapsed_ms: ev.elapsed_ms || 0 });
    if (!msg.pendingTokens.length) _pendingByTurnId.delete(turnId);
    if (!(runtime.patchMessage && runtime.patchMessage(msg.id))) runtime.render();
  }
}

// Adaptive render cadence: each patch re-parses the WHOLE active message
// (markdown + re-highlight every code block via chatMsg), so per-render cost
// grows with the message. A fixed 60ms tick on a long reply = ~16 ever-larger
// renders/sec → O(n²) main-thread work that starves keystrokes ("type slow or
// it arrives in a burst"). So we stretch the interval as the message grows:
// short replies stay at 60ms (instant), long ones back off toward a 260ms
// ceiling, bounding total render work. No content is lost — the trailing
// flushRender() on 'done' always paints the final complete state.
function renderDelay() {
  const len = (turn && turn.asstMsg && turn.asstMsg.text ? turn.asstMsg.text.length : 0);
  if (len < 2000) return 60;
  return Math.min(260, 60 + Math.floor((len - 2000) / 100));
}

function throttledRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    // Streaming deltas patch ONLY the active message in place (see
    // runtime.patchMessage) so we don't rebuild the whole document per token —
    // that's what killed text selection, scroll, and composer typing mid-stream.
    // Fall back to a full render if the bubble isn't mounted yet.
    if (!(turn && runtime.patchMessage && runtime.patchMessage(turn.msgId))) runtime.render();
  }, renderDelay());
}

function flushRender() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  runtime.render();
}

// ---- buttery streaming pump -----------------------------------------------
// Server chunks arrive bursty (whole sentences at a time). Appending them
// straight to the DOM feels choppy. Instead we buffer incoming text on
// `turn.pending` and drain a handful of chars per animation frame — so a
// 400-char burst plays out as a smooth typewriter over ~1s. Adaptive: if the
// buffer grows, we drain faster so we never fall behind the model.
function drainStreamBuffer() {
  if (!turn || !turn.asstMsg || !turn.pending) { if (turn) turn.pumpRAF = 0; return; }
  const q = turn.pending;
  // Chars per frame: floor 2, scale up with backlog so a big burst catches up
  // in ~30 frames (~0.5s at 60fps). Never more than half the buffer per frame,
  // so the tail still animates instead of dumping.
  const perFrame = Math.max(1, Math.min(Math.ceil(q.length / 60), Math.ceil(q.length / 2)));
  const take = q.slice(0, perFrame);
  turn.pending = q.slice(perFrame);
  turn.asstMsg.text += take;
  // Paint EVERY frame during the pump — the throttled path coalesces at 60–260ms
  // which makes 2-char-per-frame progress land as 15-char chunks. Bypass it so
  // each frame's small edit actually reaches the DOM.
  if (!(turn && runtime.patchMessage && runtime.patchMessage(turn.msgId))) runtime.render();
  if (turn.pending.length > 0) {
    turn.pumpRAF = requestAnimationFrame(drainStreamBuffer);
  } else {
    turn.pumpRAF = 0;
  }
}
function enqueueStreamText(delta) {
  if (!turn || !turn.asstMsg) return;
  turn.pending = (turn.pending || '') + delta;
  if (!turn.pumpRAF) turn.pumpRAF = requestAnimationFrame(drainStreamBuffer);
}
function flushStreamBuffer() {
  if (!turn) return;
  if (turn.pumpRAF) { cancelAnimationFrame(turn.pumpRAF); turn.pumpRAF = 0; }
  if (turn.pending && turn.asstMsg) {
    turn.asstMsg.text += turn.pending;
    turn.pending = '';
  }
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

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;            // under a minute: "42s"
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;  // 159s → "2:39"
}

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

// Pure slicing step for branchFromMessage — split out so it's unit-testable
// without a DOM/fetch/localStorage environment (see
// __tests__/redesign-branch-from-message.test.js). Returns null if msgId
// isn't in the thread; otherwise the {role,text} (+id) prefix through and
// including that message, in thread order.
export function sliceBranchPrefix(thread, msgId) {
  const list = Array.isArray(thread) ? thread : [];
  const idx = list.findIndex((m) => m.id === msgId);
  if (idx < 0) return null;
  return list.slice(0, idx + 1).map((m) => ({ id: m.id, role: m.role, text: m.text }));
}

// localStorage key a branched session's carried prefix is stashed under —
// shared by branchFromMessage (write), selectSession (rehydrate on reopen),
// and clearBranchPrefixIfStarted (delete once the branch has a real message).
const branchPrefixKey = (sessionId) => `branchPrefix:${sessionId}`;

// Once a live message actually lands in a branched session's thread, the
// carried prefix bubbles (state.branchPrefix, rendered by chatSurface — see
// surfaces.js) have done their job: the backend already prepended the
// preamble to that first send. Clear both the in-memory flag and its
// localStorage backing so a reload doesn't resurrect stale carried bubbles.
export function clearBranchPrefixIfStarted(state, chat) {
  if (state.branchPrefix && Array.isArray(chat.thread) && chat.thread.length > 0) {
    state.branchPrefix = null;
    try { if (chat.activeId) localStorage.removeItem(branchPrefixKey(chat.activeId)); } catch (_) {}
  }
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
function beginTurn(chat, modelLabel, sessionId) {
  // `sessionId` tags the turn with the thread it belongs to so the send-gate can
  // distinguish "THIS thread is busy" (queue) from "another thread is busy"
  // (send freely — that turn keeps streaming + recording server-side).
  turn = { sessionId: sessionId || chat.activeId || null, asstMsg: null, activity: null, thinkStep: null, byTid: {}, stepN: 0, msgId: 'live-' + Date.now(), lastFrameMs: Date.now(), got404: false };

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
    // Pending-work frames can arrive before, during, or AFTER the live turn
    // (image_generate resolves asynchronously). Handle them before the guard.
    if (ev.type === 'token.added' || ev.type === 'token.resolved') {
      _handlePendingFrame(ev, chat);
      return;
    }
    // Guard against stray frames arriving after the turn was torn down
    // (turn = null on 'done'/'error'/404). A late delta or a trailing event
    // from a resumed EventSource tail would otherwise deref null → the
    // "Cannot read properties of null (reading 'asstMsg')" crash. Drop it.
    if (!turn) return;

    // Every frame is proof of life — the hb-gap watchdog (reconcile) keys off
    // this timestamp, so it must update for ALL frame types, not just hb.
    turn.lastFrameMs = Date.now();
    if (ev.type === 'turn_start') {
      turn.turnId = ev.turn_id;
      setLiveTurn({ sessionId: turn.sessionId, turnId: ev.turn_id, msgId: turn.msgId });
      return;
    }
    if (ev.type === 'hb') return;
    // turn_end precedes [DONE]; remember the status so the done handler can
    // label a Stop ("aborted") differently from a normal finish.
    if (ev.type === 'turn_end') { turn.endStatus = ev.status || 'ok'; return; }

    if (ev.type === 'done') {
      flushStreamBuffer();
      if (turn.asstMsg) turn.asstMsg.streaming = false;
      if (turn.thinkStep) finalizeStep(turn.thinkStep);
      chat.chatStrip = stripOnTurnDone(chat.chatStrip);
      patchChatStrip(chat);
      const a = turn.activity;
      if (a) {
        finalizeAll(a);
        a.status = 'done';
        a.elapsed = fmtElapsed(a.startMs);
        // endStatus was stored by the turn_end frame handler above — read it
        // before any teardown reorders this block.
        a.worked = turn.endStatus === 'aborted'
          ? `Stopped after ${a.elapsed} · ${a.steps.length} steps`
          : `Worked for ${a.elapsed} · ${a.steps.length} steps`;
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
      if (turn.got404) { setLiveTurn(null); actions.reloadSessions(); turn = null; return; }
      refreshSidebarUsage(runtime.state);
      setLiveTurn(null);
      turn = null;
      flushQueued(chat);
      return;
    }
    if (ev.type === 'error') {
      flushStreamBuffer();
      if (turn.asstMsg) turn.asstMsg.streaming = false;
      if (ev.status === 404) { turn.got404 = true; return; }
      const m = ensureAsst();
      m.error = true;
      m.notice = ev.status
        ? `Couldn’t get a response (HTTP ${ev.status}). Try again, or pick another model.`
        : 'The connection dropped before a response arrived. Try again.';
      stopElapsed();
      flushRender();
      setLiveTurn(null);
      turn = null;
      // A turn that errored leaves the queued message intact — recall it to the
      // composer so the user doesn't lose it (rather than auto-firing into a
      // possibly-broken session).
      if (chat.queued) { actions.queueRecall(); }
      return;
    }

    // reply_reset → the agent began a NEW message mid-turn (its real reply after
    // a message-tool delivery). Drop the text shown so far so the final reply
    // isn't doubled ("Sent…Hey 👋"). Tool/thinking steps are kept.
    if (ev.type === 'reply_reset') {
      if (turn.pumpRAF) { cancelAnimationFrame(turn.pumpRAF); turn.pumpRAF = 0; }
      turn.pending = '';
      if (turn.asstMsg) turn.asstMsg.text = '';
      throttledRender();
      return;
    }
    // Promise guard (Phase 3): the reply promised a follow-up but nothing is
    // registered — surface the amber card on this turn's bubble.
    if (ev.type === 'promise_warning') {
      const m = ensureAsst();
      m.warnNotice = promiseWarningText(ev.phrase || '');
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
      turn.asstMsg.streaming = true;
      enqueueStreamText(ev.delta);
      return;
    }
    // tool start → a running tool step (prior running tools check off)
    if (ev.type === 'tool_start') {
      if (turn.thinkStep) finalizeStep(turn.thinkStep);
      if (turn.activity) finalizeTools(turn.activity);
      const kind = toolKind(ev.tool);
      const st = newStep(kind, ev.command || ev.file || ev.path || ev.tool || '', ev.tool_id);
      st.cursor = true;
      chat.chatStrip = stripReducer(chat.chatStrip, ev);
      patchChatStrip(chat);
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
        chat.chatStrip = stripReducer(chat.chatStrip, ev);
        patchChatStrip(chat);
        // Schedule an agent-linger sweep so the row disappears ~5s after done.
        scheduleStripSweep(chat);
        throttledRender();
      }
      return;
    }
    // agent_step / metrics / run_alive / stall: ignored
  };

  return { onEvent, ensureActivity };
}

// The network half of a send: detach any prior live reader, open a turn, and
// POST /api/chat_stream. Shared by the immediate path (dispatchSend) and the
// buffered composer flow (flushPending) — in both cases the optimistic bubble
// is already sitting in chat.thread by the time this runs.
function fireSend(sessionId, text, attachSnap) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const attachIds = (attachSnap || []).map((a) => a.id);
  // Sending is a user gesture — a good moment to ask for OS-notification
  // permission so a reply finishing while you're elsewhere can notify you.
  ensureNotifyPermission();

  // Detach any prior live reader. Safe now: the server-side recorder owns the
  // turn, so aborting the reader only drops THIS client's stream.
  stopLive();
  stopElapsed();

  const { onEvent, ensureActivity } = beginTurn(chat, chat.model, sessionId);
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
}

// Ensure a session exists for the active chat, creating one on first send.
// Returns the session id, or null if creation failed.
async function ensureSessionId(chat) {
  if (chat.activeId) return chat.activeId;
  try {
    const id = await createSession(chat.model);
    if (!id) return null;
    chat.activeId = id;
    storeActiveId(id);
    // Surface the brand-new thread in the sidebar IMMEDIATELY — don't wait for
    // the turn's `done` event (refreshSidebarUsage) to rebuild the list. Fire
    // and forget so it never delays the send; the row appears the moment you
    // send, so leaving the thread before the reply lands still lets you find
    // it in the conversations list.
    refreshSidebarUsage(runtime.state).catch(() => {});
    return id;
  } catch (_) {
    return null;
  }
}

// The unbuffered send: optimistic user bubble + immediate POST /api/chat_stream.
// Used by the queued-message auto-send (flushQueued), which already had its own
// review pass in the composer before it got queued. Assumes the caller already
// cleared the draft/pendingAttach.
async function dispatchSend(text, attachSnap) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const attachIds = (attachSnap || []).map((a) => a.id);
  if (!text && !attachIds.length) return;

  const sessionId = await ensureSessionId(chat);
  if (!sessionId) return;

  if (!Array.isArray(chat.thread)) chat.thread = [];
  chat.thread.push({ id: 'live-u-' + Date.now(), role: 'user', text, time: fmtTime(Date.now()), attach: attachSnap || [] });
  chat.chatStrip = stripOnUserSend(chat.chatStrip);
  clearBranchPrefixIfStarted(state, chat);
  runtime.wantChatBottom = true;   // jump to your just-sent message + the reply
  runtime.render();

  fireSend(sessionId, text, attachSnap);
}

// ---- composer send-buffer (700ms edit window) ------------------------------
// Gives Frank a brief window to fix a just-sent message before it actually
// hits the gateway. The optimistic bubble renders immediately — with a
// draining countdown ring (see chatMsg's m._optimistic branch in surfaces.js)
// — while the real POST is deferred until the buffer elapses or something
// explicitly flushes it early (a second send, or Task 8's Save & Send).
const BUFFER_MS = 700;

// Buffered composer submit: append the optimistic bubble now (with
// `_optimistic`/`_deadline` so it renders the countdown ring + the Edit
// affordance), and defer the real network fire for BUFFER_MS.
async function submitFromComposer(text, attachSnap) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const attachIds = (attachSnap || []).map((a) => a.id);
  if (!text && !attachIds.length) return;

  // A message is already buffered → flush it now, in submission order, before
  // this new one claims its own buffer window.
  if (chat.pendingSend) flushPending(chat.pendingSend.sessionId);

  const sessionId = await ensureSessionId(chat);
  if (!sessionId) return;

  const messageId = 'live-u-' + Date.now();
  const deadline = Date.now() + BUFFER_MS;
  if (!Array.isArray(chat.thread)) chat.thread = [];
  chat.thread.push({
    id: messageId, role: 'user', text, time: fmtTime(Date.now()), attach: attachSnap || [],
    _optimistic: true, _deadline: deadline,
  });
  chat.pendingSend = { messageId, text, attachSnap: attachSnap || [], sessionId, deadline, timerId: 0 };
  chat.chatStrip = stripOnUserSend(chat.chatStrip);
  clearBranchPrefixIfStarted(state, chat);
  runtime.wantChatBottom = true;
  // The countdown ring's drain is a pure CSS animation keyed off its own
  // mount time (see .msg-pending-ring / @keyframes ring-drain in
  // redesign.css) — no rAF re-render loop needed here. This one render()
  // mounts the ring; the only other render this buffer window needs is the
  // flush below.
  runtime.render();
  chat.pendingSend.timerId = setTimeout(() => flushPending(sessionId), BUFFER_MS);
}

// Fires a buffered send early — timer expiry, a second send arriving, or (in
// Task 8) an explicit Save & Send mid-edit. Clears pendingSend + the
// optimistic flags before handing off to fireSend, so msgTools' canEdit
// predicate flips false (the Edit button disappears) the instant this runs.
function flushPending(sessionId) {
  const state = runtime.state;
  if (!state) return;
  const chat = ensureChat(state);
  const p = chat.pendingSend;
  if (!p) return;
  if (p.timerId) clearTimeout(p.timerId);
  chat.pendingSend = null;
  const msg = (chat.thread || []).find((m) => m.id === p.messageId);
  if (msg) { msg.text = p.text; delete msg._optimistic; delete msg._deadline; }
  runtime.render();
  fireSend(sessionId || p.sessionId, p.text, p.attachSnap);
}

// A buffered send that's still sitting in its 700ms window when the tab
// closes was, until now, silently dropped: the setTimeout backing it never
// fires because the page is gone, so the "sent" optimistic bubble the user
// saw never actually hit the gateway. `pagehide` fires reliably on tab
// close/navigation (and, as a bonus, on iOS Safari backgrounding, which never
// fires 'unload'); flush synchronously so the request goes out before the
// page tears down. Guarded for non-browser test environments, where
// `window.addEventListener` doesn't exist.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('pagehide', () => {
    const state = runtime.state;
    const chat = state && state.live && state.live.chat;
    if (chat && chat.pendingSend) flushPending(chat.pendingSend.sessionId);
  });
}

// When a turn ends, fire any message the user queued while it was streaming.
// Deferred a microtask so the current turn teardown (turn = null) settles before
// dispatchSend opens the next one.
function flushQueued(chat) {
  if (!chat || !chat.queued) return;
  const q = chat.queued;
  chat.queued = null;
  Promise.resolve().then(() => dispatchSend(q.text, q.attachSnap));
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

// Tear down frozen local live state truthfully. `interrupted` = the backend's
// durable ledger says the turn died with the process (restart) — annotate the
// bubble instead of pretending it finished.
function finalizeLocal(chat, interrupted) {
  stopLive();
  const a = turn && turn.activity;
  if (a) {
    finalizeAll(a);
    a.status = 'done';
    a.resync = false;
    a.elapsed = fmtElapsed(a.startMs);
    a.worked = interrupted
      ? `Interrupted after ${a.elapsed} · ${a.steps.length} steps`
      : `Worked for ${a.elapsed} · ${a.steps.length} steps`;
  }
  if (interrupted && turn && turn.asstMsg) {
    turn.asstMsg.error = true;
    turn.asstMsg.notice = 'This turn was interrupted by a backend restart — the reply may be incomplete.';
  }
  setLiveTurn(null);
  turn = null;
  stopElapsed();
  if (chat.chatStrip) { chat.chatStrip = stripOnTurnDone(chat.chatStrip); patchChatStrip(chat); }
  flushRender();
  // Rescue a queued message on the interrupted path, mirroring the 'error'
  // handler: session state is uncertain, so recall to the composer rather
  // than auto-firing into a possibly-broken session. (The stale flavor's
  // flushQueued lives in reconcileTurn, AFTER its thread refetch settles —
  // flushing here would race dispatchSend's optimistic bubbles against the
  // refetch's chat.thread reassignment and leave the auto-sent turn invisible.)
  if (interrupted && chat.queued) { actions.queueRecall(); }
}

// THE single authority for "is this turn alive?". Every caller that used to
// carry its own partial logic (visibility restore, notifier tick, EventSource
// death, hb-gap watchdog, thread open) routes through here. Exactly one
// outcome per call: attach the live tail, finalize local state (stale or
// interrupted), or nothing.
let _reconcileBusy = false;
async function reconcileTurn(chat, state, sessionId) {
  if (!sessionId || _reconcileBusy) return false;
  _reconcileBusy = true;
  try {
    let snap = null;
    try {
      snap = await apiGet(`/api/chat/turn?session=${encodeURIComponent(sessionId)}`);
    } catch (_) { return false; /* backend unreachable — next trigger retries */ }
    const decision = reconcileDecision({
      active: !!(snap && snap.active),
      lastTurnStatus: (snap && snap.last_turn && snap.last_turn.status) || null,
      hasLocalLive: !!(turn || liveES),
      localSessionMatches: !turn || turn.sessionId === sessionId,
    });
    if (decision === 'attach') return attachTurn(chat, state, sessionId, snap);
    if (decision === 'finalize-interrupted') {
      // Keep the annotated local bubble — the partial text + restart notice IS
      // the honest record; the gateway transcript may have nothing better.
      finalizeLocal(chat, true);
    }
    if (decision === 'finalize-stale') {
      // The turn ended normally while we were detached: the real reply lives
      // server-side. Finalize, then refetch the thread so we never leave a
      // half-rendered answer (spec: "finalize with the real reply").
      finalizeLocal(chat, false);
      if (chat.activeId === sessionId) {
        try {
          const t = await fetchThread(sessionId, chat.model, chat.title);
          chat.thread = t.thread;
          chat.subtitle = t.subtitle || chat.subtitle;
          flushRender();
        } catch (_) { /* keep the finalized local state; next trigger retries */ }
        // Auto-send the queued follow-up ('done'-handler precedent) only AFTER
        // the refetch settles (success or catch): dispatchSend pushes the
        // optimistic user bubble + beginTurn's asstMsg into chat.thread, and a
        // still-pending refetch would replace the array wholesale, leaving the
        // whole auto-sent turn invisible. Inside the activeId guard on purpose:
        // dispatchSend targets chat.activeId (ensureSessionId), so flushing
        // after a mid-reconcile thread switch would fire the message into the
        // WRONG (newly selected) thread. Not stranded on mismatch:
        // selectSession leaves chat.queued intact, the composer banner
        // (recall/cancel) renders from it regardless of thread, and the normal
        // turn-end flush paths still own it.
        flushQueued(chat);
      }
    }
    return false;
  } finally { _reconcileBusy = false; }
}

// Re-attach to a turn that's still running server-side for `sessionId` (the
// visible win: refresh / switch-away-and-back keeps streaming). Returns true if
// it attached. Called only by `reconcileTurn` once it has already fetched the
// snapshot and decided the turn is live — replays the turn's events to rebuild
// the in-flight answer, then EventSource-tails the remainder from
// last_event_id until [DONE].
async function attachTurn(chat, state, sessionId, snap) {
  // Guard against a thread-switch that raced the snapshot fetch.
  if (chat.activeId !== sessionId) return false;

  stopLive();
  stopElapsed();
  const { onEvent, ensureActivity } = beginTurn(chat, chat.model, sessionId);
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
  es.onerror = () => {
    if (liveES !== es) return;               // superseded by a newer attach
    // CONNECTING: native auto-reconnect (with Last-Event-ID) is handling it.
    // CLOSED: the browser gave up — only a fresh snapshot can tell us whether
    // the turn is still running. Reconcile.
    if (es.readyState === EventSource.CLOSED) {
      liveES = null;
      setTimeout(() => {
        const st = runtime.state;
        const c = st && st.live && st.live.chat;
        if (c) reconcileTurn(c, st, sessionId);
      }, 1000);
    }
  };
  return true;
}

// ---- visibility / focus re-sync -------------------------------------------
// A backgrounded tab throttles rAF/timers and can silently drop the SSE tail
// (readyState stays OPEN but no bytes arrive). And even for the currently-
// visible thread, a turn that *ends* while we're away leaves local `liveES` /
// `turn` still set — so the UI shows a working state that never finalizes
// until a manual refresh. On visibility restore, snapshot-replay the active
// chat's server state: `reconcileTurn` closes a stale ES and re-tails from the
// last cursor if there's still a turn, or finalizes local state (clearing the
// chat-strip so the UI unfreezes) if not.
let _visSyncWired = false;
let _visSyncInFlight = false;
async function _syncActiveOnVisible() {
  if (_visSyncInFlight) return;
  const state = runtime.state;
  const chat = state && state.live && state.live.chat;
  if (!chat || !chat.activeId) return;
  _visSyncInFlight = true;
  try {
    await reconcileTurn(chat, state, chat.activeId);
  } catch (_) { /* non-fatal — next visibility flip retries */ }
  finally { _visSyncInFlight = false; }
}
function wireVisibilityResume() {
  if (_visSyncWired) return;
  _visSyncWired = true;
  try {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) _syncActiveOnVisible();
    });
    window.addEventListener('focus', _syncActiveOnVisible);
  } catch (_) { /* environments without document/window: harmless */ }
}
wireVisibilityResume();

// ---- heartbeat-gap watchdog -------------------------------------------------
// The backend emits an hb frame every ~10s while a turn records, and every
// frame refreshes turn.lastFrameMs. A live turn with no frame for 25s means
// the pipe is probably dead (throttled tab, dropped SSE, killed backend):
// show "Re-syncing…" and ask /api/chat/turn for the truth.
const HB_GAP_MS = 25000;
let _hbWatchTimer = null;
function startHbWatchdog() {
  if (_hbWatchTimer) return;
  _hbWatchTimer = setInterval(() => {
    if (!turn || !turn.lastFrameMs) return;   // warmup: no frame yet, no verdict
    const gap = Date.now() - turn.lastFrameMs;
    if (gap < HB_GAP_MS) {
      if (turn.activity && turn.activity.resync) { turn.activity.resync = false; throttledRender(); }
      return;
    }
    if (turn.activity && !turn.activity.resync) { turn.activity.resync = true; throttledRender(); }
    const state = runtime.state;
    const chat = state && state.live && state.live.chat;
    if (chat && turn.sessionId) reconcileTurn(chat, state, turn.sessionId);
  }, 5000);
  // Node (tests import this module without a browser event loop to keep alive)
  // returns a Timeout with .unref(); browsers return a bare number with no such
  // method. Unref so importing this module never blocks a test process on a
  // timer that's only ever meant to run in a live tab.
  if (_hbWatchTimer && typeof _hbWatchTimer.unref === 'function') _hbWatchTimer.unref();
}
startHbWatchdog();

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
  // A turn started server-side in the thread you're LOOKING at (a follow-up
  // promise firing) — attach the live tail so it streams in like any turn.
  // liveES/turn guards: skip when a tail is already attached or this client
  // is mid-send (its own POST is the stream). _notifyResuming closes the race
  // where reconcileTurn's initial fetch outlives the poll interval (liveES/turn
  // are only set after it) and a second tick would fire a concurrent attach.
  if (!liveES && !turn && chat.activeId && _notifyResuming !== chat.activeId
      && now.has(chat.activeId) && _isViewing(state, chat.activeId)) {
    _notifyResuming = chat.activeId;
    reconcileTurn(chat, state, chat.activeId)
      .catch(() => { /* non-fatal: next tick retries */ })
      .finally(() => { _notifyResuming = null; });
  }
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

// Lightweight, non-clickable info/error toast (branch/edit failures). Reuses
// the same #oc-toast-host as showChatToast but drops the "Open" affordance —
// there's no session to jump to for "couldn't branch" / "too late to edit".
function toast(text) {
  try {
    let host = document.getElementById('oc-toast-host');
    if (!host) { host = document.createElement('div'); host.id = 'oc-toast-host'; document.body.appendChild(host); }
    const el = document.createElement('div');
    el.className = 'oc-toast';
    el.style.cursor = 'default';
    el.innerHTML = '<span class="oc-toast-dot"></span><span class="oc-toast-msg"></span>';
    el.querySelector('.oc-toast-msg').textContent = text;
    host.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 220); }, 4500);
  } catch (_) { /* DOM unavailable */ }
}

// A reply finished in a thread you weren't viewing — surface it: in-app toast
// always, plus an OS notification when the user has granted permission.
function notifyTurnDone(chat, id) {
  const title = _titleFor(chat, id) || 'a chat';
  showChatToast(`__AGENT_NAME__ finished replying · ${title}`, id);
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      const n = new Notification('__AGENT_NAME__ finished replying', { body: title, tag: 'oc-turn-' + id });
      n.onclick = () => { try { window.focus(); } catch (_) {} openNotified(id); n.close(); };
    }
  } catch (_) { /* OS notifications unavailable */ }
}

// Build a self-contained, print-ready HTML document for a chat transcript.
// Reuses the same renderMarkdown() as the live thread so code blocks, lists and
// inline formatting survive into the PDF. Styling is light/print-friendly with a
// __AGENT_NAME__ brand header. The browser's own "Save as PDF" does the render,
// which keeps text selectable and crisp (no canvas rasterization).
function buildTranscriptHtml(title, thread, meta) {
  const safeTitle = String(title || 'Conversation');
  const escHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const rows = (thread || [])
    .filter((m) => String(m.text || '').trim().length > 0 || (m.attach && m.attach.length))
    .map((m) => {
      const isUser = m.role === 'user';
      const who = isUser ? 'You' : '__AGENT_NAME__';
      const time = m.time ? `<span class="t-time">${escHtml(m.time)}</span>` : '';
      const model = (!isUser && m.model) ? `<span class="t-model">${escHtml(m.model)}</span>` : '';
      const body = String(m.text || '').trim() ? renderMarkdown(m.text) : '';
      const av = isUser
        ? '<div class="t-av t-av-you">Y</div>'
        : `<div class="t-av"><img src="${escHtml(AVATAR)}" alt=""></div>`;
      return `<article class="t-msg ${isUser ? 'is-you' : 'is-asst'}">
        ${av}
        <div class="t-main">
          <div class="t-head"><span class="t-who">${escHtml(who)}</span>${model}${time}</div>
          <div class="t-body">${body}</div>
        </div>
      </article>`;
    }).join('\n');
  const count = (thread || []).filter((m) => String(m.text || '').trim().length > 0).length;
  const sub = escHtml(meta?.dateStr || '') + (count ? ` &middot; ${count} messages` : '');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<title>${escHtml(safeTitle)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root{ --ink:#1b1d22; --muted:#6b7280; --line:#e6e8ec; --accent:#2f6df6; --code-bg:#f5f6f8; }
  @page{ margin:16mm 14mm; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; }
  body{ font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        color:var(--ink); background:#fff; -webkit-print-color-adjust:exact; print-color-adjust:exact; }
  .t-wrap{ max-width:720px; margin:0 auto; padding:28px 22px 40px; }
  .t-brand{ display:flex; align-items:center; gap:12px; padding-bottom:16px; margin-bottom:22px;
            border-bottom:2px solid var(--accent); }
  .t-brand .t-logo{ width:34px; height:34px; border-radius:9px; object-fit:cover;
            background:linear-gradient(135deg,#22d3ee,#2f6df6); flex:none; }
  .t-brand h1{ font-size:19px; margin:0; line-height:1.25; font-weight:650; }
  .t-brand .t-sub{ font-size:12px; color:var(--muted); margin-top:2px; }
  .t-msg{ display:flex; gap:12px; padding:14px 0; border-bottom:1px solid var(--line);
          break-inside:avoid; page-break-inside:avoid; }
  .t-msg:last-child{ border-bottom:none; }
  .t-av{ width:30px; height:30px; border-radius:8px; flex:none; overflow:hidden;
         display:flex; align-items:center; justify-content:center; background:#eef1f5; }
  .t-av img{ width:100%; height:100%; object-fit:cover; }
  .t-av-you{ background:var(--accent); color:#fff; font-weight:650; font-size:13px; }
  .t-main{ min-width:0; flex:1; }
  .t-head{ display:flex; align-items:baseline; gap:8px; margin-bottom:3px; }
  .t-who{ font-weight:650; font-size:13.5px; }
  .is-asst .t-who{ color:var(--accent); }
  .t-model{ font-size:10.5px; color:var(--muted); border:1px solid var(--line); border-radius:5px; padding:0 5px; }
  .t-time{ font-size:11px; color:var(--muted); margin-left:auto; }
  .t-body{ font-size:13.5px; }
  .t-body p{ margin:0 0 8px; }
  .t-body p:last-child{ margin-bottom:0; }
  .t-body h1,.t-body h2,.t-body h3{ font-size:14.5px; margin:12px 0 6px; }
  .t-body ul,.t-body ol{ margin:6px 0 8px; padding-left:22px; }
  .t-body li{ margin:2px 0; }
  .t-body code{ background:var(--code-bg); border-radius:4px; padding:1px 5px; font-size:12px;
                font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
  .t-body pre{ background:var(--code-bg); border:1px solid var(--line); border-radius:8px;
               padding:11px 13px; overflow-x:auto; break-inside:avoid; page-break-inside:avoid; }
  .t-body pre code{ background:none; padding:0; font-size:12px; line-height:1.5; }
  .t-body blockquote{ margin:6px 0; padding:2px 12px; border-left:3px solid var(--line); color:var(--muted); }
  .t-body a{ color:var(--accent); text-decoration:none; }
  .t-foot{ margin-top:26px; padding-top:12px; border-top:1px solid var(--line);
           font-size:10.5px; color:var(--muted); text-align:center; }
</style></head>
<body>
  <div class="t-wrap">
    <header class="t-brand">
      <img class="t-logo" src="${escHtml(AVATAR)}" alt="">
      <div><h1>${escHtml(safeTitle)}</h1><div class="t-sub">${sub}</div></div>
    </header>
    ${rows || '<p style="color:#6b7280">This conversation has no messages yet.</p>'}
    <div class="t-foot">Exported from __AGENT_NAME__ &middot; ${escHtml(meta?.dateStr || '')}</div>
  </div>
</body></html>`;
}

let _convSearchTimer = null;
let _convSearchSeq = 0;

export const actions = {
  // Semantic search across ALL conversations by message CONTENT (not just the
  // title substring the list filters on locally). Debounced; hits land in
  // chat.searchResults and render as a MESSAGES section under the title matches
  // (see surfaces.js convListBody). A short/empty query clears the results.
  convSearch: (query) => {
    const chat = runtime.state && runtime.state.live && runtime.state.live.chat;
    if (!chat) return;
    const q = (query || '').trim();
    chat.searchQuery = q;
    if (_convSearchTimer) { clearTimeout(_convSearchTimer); _convSearchTimer = null; }
    if (q.length < 2) { chat.searchResults = null; chat.searchLoading = false; return; }
    chat.searchLoading = true;
    const seq = ++_convSearchSeq;
    _convSearchTimer = setTimeout(async () => {
      let res = [];
      try { res = await apiGet(`/api/search?q=${encodeURIComponent(q)}&limit=20`); }
      catch (_) { res = []; }
      if (seq !== _convSearchSeq) return;  // a newer keystroke superseded this one
      chat.searchResults = Array.isArray(res) ? res : [];
      chat.searchLoading = false;
      runtime.render();
    }, 280);
  },

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
    _pendingByTurnId.clear();
    chat.rowMenuOpen = null;
    saveStripForCurrent(chat);
    chat.activeId = id;
    chat.chatStrip = loadStripForKey(chat, id);
    // Hydrate from server if in-memory strip has no pending tasks (covers fresh
    // PWA loads where chatStripByKey is empty). Runs async so it doesn't block
    // the rest of selectSession; only applied if the user is still on this session.
    if (!chat.chatStrip.todos || !(chat.chatStrip.todos.items || []).length) {
      (async () => {
        try {
          const res = await apiGet(`/api/strip/state?session=${encodeURIComponent(id)}`);
          const tasks = Array.isArray(res && res.tasks) ? res.tasks : [];
          if (tasks.length && chat.activeId === id) {
            chat.chatStrip = { ...chat.chatStrip, todos: { msgId: null, items: tasks, updatedAt: Date.now() } };
            patchChatStrip(chat);
            runtime.render();
          }
        } catch (_) { /* non-fatal */ }
      })();
    }
    chat.editingId = null;
    if (chat.notified) chat.notified.delete(id);  // opening it clears its dot
    storeActiveId(id);
    // Rehydrate a carried branch prefix (Task 8): branchFromMessage stashes it
    // in localStorage keyed by the NEW session's id before switching to it, so
    // this covers both the initial jump into a freshly-branched thread and any
    // later reopen (e.g. after a reload) before its first real message lands.
    try {
      const raw = localStorage.getItem(branchPrefixKey(id));
      state.branchPrefix = raw ? JSON.parse(raw) : null;
    } catch (_) { state.branchPrefix = null; }
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
      // A reopened session that already has real history (e.g. another tab
      // already sent its first message) shouldn't still show carried bubbles.
      clearBranchPrefixIfStarted(state, chat);
      runtime.wantChatBottom = true;   // land on the latest message once loaded
    } catch (_) { /* keep prior */ }
    // Re-attach to an in-flight turn for this thread, if one is still running
    // server-side (returning to a thread you left mid-answer).
    try { await reconcileTurn(chat, state, id); } catch (_) { /* non-fatal */ }
    // Populate resolved update_blocks that the frontend missed while away.
    try { await hydrateThread(id, chat.thread); } catch (_) { /* non-fatal */ }
    try { await hydrateWarnings(id, chat.thread); } catch (_) { /* non-fatal */ }
    const pct = await fetchUsage(id);
    if (pct != null) chat.usagePct = pct;
    runtime.render();
  },

  newChat: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    // Detach this client's live reader from whatever thread was streaming, same
    // as selectSession(). The prior turn keeps running + recording server-side
    // (re-attached via reconcileTurn on return); clearing `turn` here means the
    // first message in this fresh thread sends immediately instead of queueing
    // behind the thread we just left.
    stopLive();
    stopElapsed();
    turn = null;
    _pendingByTurnId.clear();
    const _leavingId = chat.activeId;
    saveStripForCurrent(chat);
    if (_leavingId) {
      fetch(`/api/strip/state?session=${encodeURIComponent(_leavingId)}`, {
        method: 'DELETE', credentials: 'same-origin',
      }).catch(() => {});
    }
    chat.activeId = null;
    chat.chatStrip = stripOnSessionSwitch();
    chat.editingId = null;
    storeActiveId(null);
    chat.thread = [];
    chat.title = 'New chat';
    state.branchPrefix = null; // a fresh chat carries no branch context
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
    const attachSnap = state.pendingAttach ? [...state.pendingAttach] : [];
    if (!text && !attachSnap.length) return;
    const chat = ensureChat(state);

    // A turn is already streaming FOR THIS THREAD → queue this message instead of
    // starting a second turn against the same thread. It shows as a pending
    // banner the user can edit (recall) or cancel; when the current turn ends it
    // auto-sends (see flushQueued in the turn-end paths). A turn streaming in a
    // DIFFERENT thread must NOT gate this send — that turn keeps running +
    // recording server-side, and dispatchSend() detaches our reader from it.
    if (turn && turn.sessionId === chat.activeId) {
      chat.queued = { text, attachSnap };
      state.draft = '';
      state.pendingAttach = [];
      runtime.render();
      return;
    }

    state.draft = '';
    state.pendingAttach = []; // consumed by this turn
    await submitFromComposer(text, attachSnap);
  },

  // Pull a queued message back into the composer to edit/recall it.
  queueRecall: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    if (!chat.queued) return;
    state.draft = chat.queued.text || '';
    state.pendingAttach = chat.queued.attachSnap ? [...chat.queued.attachSnap] : [];
    chat.queued = null;
    runtime.render();
    const ta = document.querySelector('[data-focus="draft"],[data-focus="mdraft"]');
    if (ta) ta.focus();
  },

  // Drop a queued message without sending it.
  queueCancel: () => {
    const state = runtime.state;
    if (!state) return;
    ensureChat(state).queued = null;
    runtime.render();
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
    // Stop is a deliberate halt — don't auto-fire a queued follow-up. Hand it
    // back to the composer so the user decides whether to send it.
    if (runtime.state && ensureChat(runtime.state).queued) { actions.queueRecall(); }
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

  // Shared model-picker loader. Desktop uses a popover; mobile uses a sheet,
  // but both need the same endpoint-grouped catalog and current default.
  loadModelOptions: async () => {
    const state = runtime.state;
    if (!state) return;
    if (!(state.live && state.live.modelGroups)) {
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
    try {
      const dc = await apiGet('/api/default-chat');
      state.live = state.live || {};
      state.live.defaultModel = ((dc && dc.endpoint_id) || '') + MODEL_SEP + ((dc && dc.model) || '');
      runtime.render();
    } catch (_) { /* ignore */ }
  },

  // Composer model picker: open/close the desktop popover, then lazily load
  // the shared catalog. Mobile calls loadModelOptions directly for its sheet.
  toggleModelMenu: async () => {
    const state = runtime.state;
    if (!state) return;
    const open = !state.modelMenuOpen;
    state.modelMenuOpen = open;
    runtime.render();
    if (open) await actions.loadModelOptions();
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
      state.pendingAttach = [...(state.pendingAttach || []), ...saved.map((s) => ({ id: s.id, name: s.name, url: s.url }))];
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

  // Chat-strip: collapse/expand toggle (persists to localStorage).
  toggleChatStrip: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    let storage = null;
    try { storage = window.localStorage; } catch (_) {}
    chat.chatStrip = stripToggleCollapsed(chat.chatStrip, storage);
    runtime.render();
  },

  // Chat-strip: dismiss the plan preview without waiting for the next send.
  dismissStripPlan: () => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    if (!chat.chatStrip || !chat.chatStrip.plan) return;
    chat.chatStrip = { ...chat.chatStrip, plan: null };
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
    const text = thread.map((m) => `${m.role === 'user' ? 'You' : '__AGENT_NAME__'}: ${m.text || ''}`).join('\n\n');
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
    const md = `# ${title}\n\n` + (chat.thread || []).map((m) => `**${m.role === 'user' ? 'You' : '__AGENT_NAME__'}:** ${m.text || ''}`).join('\n\n');
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
  // Export the transcript as a nicely-styled PDF, one-click download. Builds the
  // same print-ready HTML (reusing renderMarkdown) and POSTs it to the backend,
  // which renders it to a real PDF with headless Chrome and streams it back as a
  // file — no print dialog, selectable text, identical styling. Falls back to
  // the browser print dialog, then an .html download, if the endpoint is down.
  exportChatPDF: async () => {
    const state = runtime.state;
    if (!state) return;
    state.chatMenuOpen = false;
    const chat = ensureChat(state);
    const title = chat.title || 'Conversation';
    let thread = chat.thread || [];
    // If the open chat's live thread is empty (e.g. reopened but not yet
    // hydrated), pull the transcript from history so the export isn't blank.
    if ((!thread || !thread.length) && chat.activeId) {
      try {
        const hist = await apiGet(`/api/history/${chat.activeId}?limit=500`);
        const list = Array.isArray(hist?.history) ? hist.history : [];
        thread = list.map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', text: h.content || '', model: h.metadata?.model }));
      } catch (_) { thread = chat.thread || []; }
    }
    let dateStr = '';
    try { dateStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) {}
    const html = buildTranscriptHtml(title, thread, { dateStr });
    const safe = title.replace(/[^\w.-]+/g, '_') || 'conversation';

    // Trigger a browser download from a blob.
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    };

    // Preferred path: server renders a real PDF → one-click file download.
    try {
      const res = await fetch(`${location.origin}/api/export/pdf`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, filename: `${safe}.pdf` }),
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size) {
          download(blob, `${safe}.pdf`);
          runtime.render();
          return;
        }
      }
    } catch (_) { /* fall through to print/html fallbacks */ }

    // Fallback 1: browser print dialog via sandboxed hidden iframe.
    try {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(frame);
      const doc = frame.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
      const go = () => {
        try {
          frame.contentWindow.focus();
          frame.contentWindow.print();
        } catch (_) {}
        setTimeout(() => { try { frame.remove(); } catch (_) {} }, 60000);
      };
      // Give images (avatar) a beat to load so they render in the PDF.
      if (frame.contentWindow.document.readyState === 'complete') setTimeout(go, 250);
      else frame.addEventListener('load', () => setTimeout(go, 250), { once: true });
    } catch (_) {
      // Fallback 2: hand over the styled HTML.
      try { download(new Blob([html], { type: 'text/html' }), `${safe}.html`); } catch (_) {}
    }
    runtime.render();
  },

  // Session list: archive a conversation → POST /api/session/{id}/archive.
  archiveSession: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.rowMenuOpen = null;
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

  // Message toolbar: branch a NEW session off the transcript up through this
  // message. The client already rendered these bubbles, so it slices its own
  // `chat.thread` rather than trusting the server to re-fetch/re-slice history
  // (see backend's /api/session/branch docstring — same reasoning). Stash the
  // echoed-back prefix in localStorage BEFORE switching sessions so
  // selectSession's rehydrate step (above) picks it up as part of the same
  // open, whether this is the initial jump or a later reopen.
  branchFromMessage: async (msgId) => {
    const state = runtime.state;
    if (!state || !msgId) return;
    const chat = ensureChat(state);
    const sourceId = chat.activeId;
    const prefixSlice = sliceBranchPrefix(chat.thread, msgId);
    if (!prefixSlice) { toast(`Couldn't find that message`); return; }
    if (!sourceId) { toast(`Couldn't branch: no active session`); return; }
    let body = {};
    try {
      const res = await fetch('/api/session/branch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source_session_id: sourceId, prefix: prefixSlice }),
      });
      try { body = await res.json(); } catch (_) { body = {}; }
      if (!res.ok) { toast(`Couldn't branch: ${body.error || res.status}`); return; }
    } catch (e) {
      toast(`Couldn't branch: ${String(e && e.message || e)}`);
      return;
    }
    const { session_id, prefix } = body;
    if (!session_id) { toast(`Couldn't branch: no session returned`); return; }
    try { await refreshSidebarUsage(state); } catch (_) { /* sidebar refresh is best-effort */ }
    try { localStorage.setItem(branchPrefixKey(session_id), JSON.stringify(prefix || prefixSlice)); } catch (_) {}
    await actions.selectSession(session_id);
  },

  // Message toolbar: open the inline editor for the still-buffered optimistic
  // bubble (msgTools' canEdit only shows the button while pendingSend.messageId
  // matches — this re-checks server-side-of-the-click in case the 700ms window
  // lapsed between render and click). Actual DOM swap happens through state:
  // chatMsg (surfaces.js) renders a textarea + Save/Cancel bar when
  // chat.editingId === m.id, since render() rebuilds root.innerHTML wholesale
  // on every action dispatch (direct DOM surgery here would be wiped the
  // instant this handler returns).
  editMessage: (msgId) => {
    const state = runtime.state;
    if (!state || !msgId) return;
    const chat = ensureChat(state);
    if (!chat.pendingSend || chat.pendingSend.messageId !== msgId) return;
    chat.editingId = msgId;
    state.editDraft = chat.pendingSend.text;
    runtime.render();
  },

  // Save & Send: commit the textarea's value into the still-buffered message
  // and flush immediately — Frank made his final call, no reason to wait out
  // the rest of the 700ms window.
  saveEdit: (msgId) => {
    const state = runtime.state;
    if (!state || !msgId) return;
    const chat = ensureChat(state);
    chat.editingId = null;
    if (!chat.pendingSend || chat.pendingSend.messageId !== msgId) {
      // The buffer already flushed (timer won the race) — too late to edit.
      toast(`Too late to edit — __AGENT_NAME__ already started`);
      state.editDraft = null;
      runtime.render();
      return;
    }
    const text = state.editDraft != null ? state.editDraft : chat.pendingSend.text;
    // Empty-text guard: if Frank cleared the textarea, treat Save & Send as
    // "drop the buffered send" — better UX than posting an empty message and
    // safer than fireSend, which no longer has its own empty guard on this path.
    if (!text.trim() && !(chat.pendingSend.attachSnap && chat.pendingSend.attachSnap.length)) {
      clearTimeout(chat.pendingSend.timerId);
      chat.pendingSend = null;
      const idx = (chat.thread || []).findIndex((m) => m.id === msgId);
      if (idx >= 0) chat.thread.splice(idx, 1);
      state.editDraft = null;
      runtime.render();
      return;
    }
    chat.pendingSend.text = text;
    const msg = (chat.thread || []).find((m) => m.id === msgId);
    if (msg) msg.text = text;
    state.editDraft = null;
    flushPending(chat.activeId);
  },

  // Cancel: close the inline editor, keep the original buffered text/deadline
  // untouched (it still fires on its own timer, or on the next explicit flush).
  cancelEdit: (msgId) => {
    const state = runtime.state;
    if (!state) return;
    const chat = ensureChat(state);
    if (chat.editingId === msgId) chat.editingId = null;
    state.editDraft = null;
    runtime.render();
  },

  // Message toolbar: open/close the per-message download flyout (MD vs PDF).
  toggleMsgMenu: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.msgMenuOpen = chat.msgMenuOpen === id ? null : id;
    chat.rowMenuOpen = null;
    state.chatMenuOpen = false;
    runtime.render();
  },

  // Message toolbar: download one message's text as a .md file (client-side).
  downloadMessage: (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.msgMenuOpen = null;
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) { runtime.render(); return; }
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
    runtime.render();
  },

  // Message toolbar: download one message as a styled PDF. Reuses the same
  // server render path as the whole-chat export, with a one-message thread.
  downloadMessagePDF: async (id) => {
    const state = runtime.state;
    if (!state || !id) return;
    const chat = ensureChat(state);
    chat.msgMenuOpen = null;
    const msg = (chat.thread || []).find((m) => m.id === id);
    if (!msg || !msg.text) { runtime.render(); return; }
    const who = msg.role === 'user' ? 'you' : 'gary';
    const slug = (msg.text.split('\n')[0] || 'message').slice(0, 40).replace(/[^\w.-]+/g, '_');
    const safe = `${who}-${slug}` || 'message';
    const title = chat.title || 'Message';
    let dateStr = '';
    try { dateStr = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) {}
    const html = buildTranscriptHtml(title, [msg], { dateStr });
    const download = (blob, name) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
    };
    runtime.render();
    // Preferred: server renders a real PDF → one-click file download.
    try {
      const res = await fetch(`${location.origin}/api/export/pdf`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ html, filename: `${safe}.pdf` }),
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob && blob.size) { download(blob, `${safe}.pdf`); return; }
      }
    } catch (_) { /* fall through to print/html fallbacks */ }
    // Fallback 1: browser print dialog via sandboxed hidden iframe.
    try {
      const frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(frame);
      const doc = frame.contentWindow.document;
      doc.open(); doc.write(html); doc.close();
      const go = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch (_) {}
        setTimeout(() => { try { frame.remove(); } catch (_) {} }, 60000);
      };
      if (frame.contentWindow.document.readyState === 'complete') setTimeout(go, 250);
      else frame.addEventListener('load', () => setTimeout(go, 250), { once: true });
    } catch (_) {
      try { download(new Blob([html], { type: 'text/html' }), `${safe}.html`); } catch (_) {}
    }
  },

  // Swallow clicks on menu chrome so they neither select the row nor close the menu.
  noop: () => {},
};
