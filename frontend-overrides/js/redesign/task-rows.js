// Task progress rows — inline live status for background jobs.
//
// Attribution rules (critical, learned the hard way):
//
//   1. Row ONLY appears in the chat/thread that started the task. Task files
//      carry a `sessionKey` like `agent:main:web-6b3ccecab880`. The workspace
//      chat stores its own client-side id in `localStorage.redesign.chat.activeId`
//      (the `6b3ccecab880` part). If `task.sessionKey` doesn't end with that
//      id, we skip the task entirely on this tab.
//
//   2. Row ONLY appears in the assistant bubble it was FIRST attached to. On
//      first successful injection we capture the DOM's client-side msg-id
//      (`live-<timestamp>`) into `state.domMsgId`. On subsequent polls we
//      look up by that captured id and NEVER fall back to "newest asst" —
//      that fallback is what caused done rows to jump into fresh replies.
//
//   3. Anti-flicker: single global MutationObserver on the chat root. When
//      the chat store re-renders the msg during Gary's tool calls, our node
//      gets nuked and re-injected within the same paint frame.

import { liveTurn } from './live/turn-ref.js';

const CHAT_ACTIVE_ID_LSKEY = 'redesign.chat.activeId';

function activeChatId() {
  try { return localStorage.getItem(CHAT_ACTIVE_ID_LSKEY) || ''; }
  catch { return ''; }
}

// task.sessionKey looks like `agent:main:web-<12hex>`; the trailing chunk is
// the workspace chat activeId. If it doesn't match this tab's active chat,
// the task belongs to a different thread — don't render it here.
function taskBelongsToThisChat(task) {
  const active = activeChatId();
  if (!active) return false;               // no active chat → can't attribute
  if (!task.sessionKey) return false;      // task not tagged → can't attribute
  return task.sessionKey.endsWith(active);
}

function hms(sec) {
  if (sec == null || sec !== sec || sec < 0) return '--:--';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
           : `${m}:${String(s).padStart(2, '0')}`;
}

const KIND_COLOR = {
  render:  'var(--gold)',
  upload:  'var(--blue)',
  download:'var(--blue)',
  pull:    'var(--teal)',
  publish: 'var(--green)',
  export:  'var(--violet)',
  scan:    'var(--faint)',
  followup:'var(--teal)',
  auto:    'var(--amber)',
};

// Per-task state: taskId -> { row, refs, domMsgId }
// domMsgId is the client-side `data-msg-id` we pinned at first injection.
// Once set, we NEVER change it — the row lives in that specific bubble.
const _tasks = new Map();

// Pure template for the row's static skeleton. The only dynamic value is
// task.kind (agent-derived — written into share/tasks/<id>/progress.json by
// whatever wrote the task, see workspace_files.py `/api/tasks/active`), used
// here only as a lookup key into the hardcoded KIND_COLOR map — never
// interpolated as a raw string. An unrecognized/hostile task.kind can only
// ever select the map's own fixed values or the hardcoded fallback, so no
// attacker-controlled text ever reaches this innerHTML sink. All other task
// fields (label, detail, error, …) are rendered later via textContent in
// paint(), not through this template. Exported so the whitelist behavior can
// be pinned by a test without needing a DOM.
export function taskRowHtml(task) {
  const dotColor = Object.prototype.hasOwnProperty.call(KIND_COLOR, task.kind)
    ? KIND_COLOR[task.kind] : 'var(--faint)';
  return `
    <div class="task-head">
      <span class="task-dot" style="background:${dotColor}"></span>
      <span class="task-label shimmer"></span>
      <span class="task-badge"></span>
      <span class="task-oc-spacer"></span>
    </div>
    <div class="task-bar-wrap">
      <div class="task-fill">
        <div class="task-fill-shimmer"></div>
      </div>
    </div>
    <div class="task-meta">
      <span class="task-detail"></span>
      <span class="task-oc-spacer"></span>
      <span class="task-pct"></span>
      <span class="task-eta"></span>
      <span class="task-elapsed"></span>
      <span class="task-err"></span>
    </div>
  `;
}

// Map a registry record to the native payload this module renders. Only
// taskfile + followup sources are in-chat rows (job-source = global overlay,
// research = research tab, pending = the ⏳ pill in chat.js).
export function nativeView(rec) {
  if (!rec || (rec.source !== 'taskfile' && rec.source !== 'followup')) return null;
  const statusFor = (state) => (state === 'running' || state === 'stalled') ? 'running'
    : state === 'done' ? 'done' : 'failed';
  if (rec.source === 'followup') {
    return {
      id: rec.id, label: rec.label || rec.id, kind: rec.kind === 'auto' ? 'auto' : 'followup',
      status: statusFor(rec.state), detail: rec.detail || '',
      error: rec.state === 'interrupted' ? 'interrupted by a backend restart' : (rec.error || ''),
      sessionKey: rec.session_key || '',
      // Running rows: elapsed is ticker-owned (tickElapsed) — a second
      // per-event formula here raced it and could flash "--:--" on negative
      // clock skew. Terminal rows keep a server-stamped created→updated
      // duration (skew-free) so the done row still shows how long it took.
      elapsed: rec.state === 'running' || !rec.created
        ? null
        : (rec.updated && rec.created ? Math.max(0, (rec.updated - rec.created) / 1000) : null),
      _recTurnId: rec.turn_id ?? null,
      _createdMs: rec.created || null,
    };
  }
  const native = (rec.extra && rec.extra.native) || null;
  if (!native || !native.id) return null;
  const out = { ...native, status: statusFor(rec.state), _recTurnId: rec.turn_id ?? null, _createdMs: rec.created || null };
  out.sessionKey = out.sessionKey || rec.session_key || '';
  if (rec.state === 'interrupted') out.error = out.error || 'interrupted by a backend restart';
  return out;
}

// Live elapsed for rows whose clock is client-derived (followup/auto — their
// registry record only pushes events on STATE changes, so without this tick
// the "elapsed" read froze at whatever the last event computed; live-fire
// 2026-07-10 showed a permanent "elapsed 0:00"). Producer-timed kinds
// (taskfile natives carrying their own elapsed) stay authoritative.
export function tickElapsed(view, nowMs) {
  if (!view || view.status !== 'running') return null;
  if (view.kind !== 'followup' && view.kind !== 'auto') return null;
  if (view._createdMs == null) return null;
  return Math.max(0, (nowMs - view._createdMs) / 1000);
}

// Deterministic bubble anchoring when the record carries the ledger turn_id
// and it matches the live turn; otherwise the legacy pin heuristic.
export function anchorMode(rec, liveTurnId) {
  return (rec && rec.turn_id != null && liveTurnId != null && rec.turn_id === liveTurnId)
    ? 'turn' : 'pin';
}

function buildRow(task) {
  const row = document.createElement('div');
  row.className = 'task-row';
  row.setAttribute('data-task-id', task.id);
  row.innerHTML = taskRowHtml(task);
  return {
    row,
    refs: {
      label:   row.querySelector('.task-label'),
      badge:   row.querySelector('.task-badge'),
      fill:    row.querySelector('.task-fill'),
      detail:  row.querySelector('.task-detail'),
      pct:     row.querySelector('.task-pct'),
      eta:     row.querySelector('.task-eta'),
      elapsed: row.querySelector('.task-elapsed'),
      err:     row.querySelector('.task-err'),
    },
  };
}

function paint(refs, row, task) {
  if (refs.label.textContent !== task.label) refs.label.textContent = task.label || task.id;
  refs.label.classList.toggle('shimmer', task.status === 'running');

  const badge = task.status === 'done' ? '✓ done'
              : task.status === 'failed' ? '✗ failed'
              : 'running';
  if (refs.badge.textContent !== badge) refs.badge.textContent = badge;
  refs.badge.className = 'task-badge ' + task.status;

  row.classList.toggle('task-done',    task.status === 'done');
  row.classList.toggle('task-failed',  task.status === 'failed');
  row.classList.toggle('task-running', task.status === 'running');

  const pct = task.status === 'done' ? 100
            : task.status === 'failed' ? 100
            : Math.max(0, Math.min(100, task.pct ?? 0));
  refs.fill.style.width = pct.toFixed(1) + '%';
  refs.fill.className = 'task-fill ' + task.status;

  const seg = task.segText ? ` · ${task.segText}` : '';
  const detailText = (task.detail || '') + seg;
  if (refs.detail.textContent !== detailText) refs.detail.textContent = detailText;

  const pctText = task.status === 'running' ? `${Math.round(pct)}%` : '';
  if (refs.pct.textContent !== pctText) refs.pct.textContent = pctText;

  const etaText = task.status === 'running' && task.eta != null
    ? `eta ${hms(task.eta)}` : '';
  if (refs.eta.textContent !== etaText) refs.eta.textContent = etaText;

  const elapsedText = task.elapsed != null ? `elapsed ${hms(task.elapsed)}` : '';
  if (refs.elapsed.textContent !== elapsedText) refs.elapsed.textContent = elapsedText;

  const errText = task.status === 'failed' ? (task.error || 'failed') : '';
  if (refs.err.textContent !== errText) refs.err.textContent = errText;
}

// Look up the assistant bubble for a task. Prefer the pinned client-side id.
// On first pin, use "newest .msg-asst on screen" as a heuristic (that IS
// the bubble Gary is working in when the task starts). After that first
// pin, we NEVER re-choose — no fallback that could steal into a new reply.
function findMsgEl(state) {
  if (state.domMsgId) {
    return document.querySelector(`[data-msg-id="${CSS.escape(state.domMsgId)}"]`);
  }
  const asst = document.querySelectorAll('.msg-asst[data-msg-id], .m-msg-asst[data-msg-id]');
  return asst.length ? asst[asst.length - 1] : null;
}

function findOrMakeSpine(msgEl) {
  let spine = msgEl.querySelector('.act-spine');
  if (spine) return { spine, synthesized: false };
  let wrap = msgEl.querySelector('.act-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'act-wrap task-only';
    const body = msgEl.querySelector('.msg-body, .m-md');
    if (body) body.insertBefore(wrap, body.firstChild);
    else msgEl.insertBefore(wrap, msgEl.firstChild);
  }
  spine = document.createElement('div');
  spine.className = 'act-spine task-spine';
  wrap.appendChild(spine);
  return { spine, synthesized: true };
}

let _globalObs = null;

function reinjectAll() {
  for (const [, state] of _tasks) {
    if (!state.domMsgId) continue;         // never pinned yet — poll will handle
    const msgEl = findMsgEl(state);
    if (!msgEl) continue;                  // pinned bubble not currently in DOM
    if (!msgEl.contains(state.row) || !document.body.contains(state.row)) {
      const { spine } = findOrMakeSpine(msgEl);
      spine.appendChild(state.row);
    }
  }
}

function ensureGlobalObserver() {
  if (_globalObs) return;
  const root = document.querySelector('.chat, .live-chat, .thread, main') || document.body;
  _globalObs = new MutationObserver(() => {
    if (_tasks.size === 0) return;
    reinjectAll();
  });
  _globalObs.observe(root, { childList: true, subtree: true });
}

function renderOrUpdateRow(task) {
  let state = _tasks.get(task.id);
  if (!state) {
    // FIRST OBSERVATION RULE: only start tracking a task if we see it while
    // it's still running. If the first time this tab sees the task it's
    // already done/failed, skip it entirely. This closes the "thread-switch
    // flash" bug: during the ~1s DOM swap between threads, localStorage's
    // activeId updates first — a poll fired in that gap would otherwise pin
    // a stale "newest asst" from the outgoing thread. If we never watched
    // it run, we don't get a row.
    if (task.status !== 'running') return;

    const built = buildRow(task);
    state = { row: built.row, refs: built.refs, domMsgId: null };
    _tasks.set(task.id, state);
    ensureGlobalObserver();
  }
  // First injection: pin to the exact bubble, then append via the spine.
  // Both anchor paths below fall through to the same lookup + append code —
  // only HOW domMsgId gets its first value differs.
  if (!state.domMsgId) {
    // Deterministic anchor: the record knows its originating ledger turn and
    // that turn is live right now — pin to its exact bubble, no heuristic.
    const lt = liveTurn();
    if (lt && anchorMode({ turn_id: task._recTurnId }, lt.turnId) === 'turn'
        && lt.sessionId === activeChatId()) {
      state.domMsgId = lt.msgId;
    }
    // Heuristic fallback: "newest asst bubble" (findMsgEl uses domMsgId when
    // set, so this also resolves the deterministic pin above by its exact id).
    const msgEl = findMsgEl(state);
    if (!msgEl) return;                    // no bubble yet — wait
    if (!state.domMsgId) state.domMsgId = msgEl.getAttribute('data-msg-id');
    const { spine } = findOrMakeSpine(msgEl);
    spine.appendChild(state.row);
  } else {
    // Subsequent polls: strictly by pinned id. No stealing.
    const msgEl = findMsgEl(state);
    if (msgEl && (!msgEl.contains(state.row) || !document.body.contains(state.row))) {
      const { spine } = findOrMakeSpine(msgEl);
      spine.appendChild(state.row);
    }
    // If the pinned bubble isn't rendered right now (thread switch, scrolled
    // off, etc.), do nothing — the row waits with its bubble.
  }
  paint(state.refs, state.row, task);
  state.view = task;
}

function reap(activeIds) {
  for (const [id, state] of Array.from(_tasks.entries())) {
    if (activeIds.has(id)) continue;
    if (state.row.parentNode) state.row.parentNode.removeChild(state.row);
    _tasks.delete(id);
  }
  document.querySelectorAll('.act-wrap.task-only').forEach((w) => {
    if (!w.querySelector('.task-row')) w.remove();
  });
  if (_tasks.size === 0 && _globalObs) {
    _globalObs.disconnect();
    _globalObs = null;
  }
}

import { subscribeTasks } from './live/task-feed.js';

function applyFeed(records) {
  const mine = [];
  for (const rec of records) {
    const v = nativeView(rec);
    if (v && taskBelongsToThisChat(v)) mine.push(v);
  }
  const active = new Set();
  for (const t of mine) {
    if (!t.id) continue;
    active.add(t.id);
    renderOrUpdateRow(t);
  }
  reap(active);
}

let _elapsedTimer = null;
function startElapsedTicker() {
  if (_elapsedTimer) return;
  _elapsedTimer = setInterval(() => {
    for (const [, state] of _tasks) {
      const secs = tickElapsed(state.view, Date.now());
      if (secs == null || !state.refs) continue;
      const text = `elapsed ${hms(secs)}`;
      if (state.refs.elapsed.textContent !== text) state.refs.elapsed.textContent = text;
    }
  }, 1000);
  if (_elapsedTimer && typeof _elapsedTimer.unref === 'function') _elapsedTimer.unref();
}

let _started = false;
export function startTaskRows() {
  if (_started) return;
  _started = true;
  subscribeTasks(applyFeed);
  startElapsedTicker();
}

if (typeof window !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startTaskRows);
  } else {
    startTaskRows();
  }
}
