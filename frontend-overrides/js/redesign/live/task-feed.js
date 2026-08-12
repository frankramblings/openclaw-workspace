// The ONE consumer of /api/tasks/stream. Every progress surface (in-chat
// task rows, the jobs overlay, anything future) subscribes here instead of
// owning its own transport — one EventSource, one backoff policy, one
// GET-fallback, applied once (this replaces task-rows' 1s polling and the
// overlay's private stream).
//
// Pure parts (reduceFeedEvent, nextBackoff, pruneTerminal) are exported for
// node:test.

import { runtime } from './runtime.js';

const STREAM = '/api/tasks/stream';
const FALLBACK = '/api/tasks';

export function reduceFeedEvent(map, ev) {
  if (!ev || typeof ev !== 'object') return map;
  if (ev.type === 'tasks.snapshot' && Array.isArray(ev.tasks)) {
    const next = new Map();
    for (const t of ev.tasks) {
      if (!t || !t.id) continue;
      // Carry forward an existing _fgSeen stamp: any snapshot (including the
      // one a visibility resume gets from the stream) otherwise looks like a
      // brand-new sighting and restarts the terminal-row budget, so a job
      // that finished minutes ago rides the server's much longer
      // RETAIN_TERMINAL_S instead of TERMINAL_FOREGROUND_MS. A row that's
      // newly terminal has no prior stamp, so it still gets one fresh on its
      // first visible render via markSeen.
      //
      // Gated on state IDENTITY (fix round 2), not just "was there a prior
      // stamp": task_ingest.py deliberately revives an interrupted row back
      // to running when a producer's file postdates the death verdict
      // (honesty runs both directions), and also lets a terminal file
      // overturn a death verdict directly to done. An unconditional
      // carry-forward inherited the OLD state's stamp onto the new state; since
      // markSeen only stamps rows with _fgSeen == null, that stale stamp was
      // never refreshed, and a job that finished many minutes later could be
      // pruned before _notify ever handed its 'done' state to a subscriber —
      // interrupted -> running -> vanished, never seen as done. A row
      // entering a genuinely new state has earned a fresh budget.
      const prev = map.get(t.id);
      next.set(t.id, prev && prev._fgSeen != null && prev.state === t.state ? { ...t, _fgSeen: prev._fgSeen } : t);
    }
    // The server ages terminal records out at RETAIN_TERMINAL_S, so a snapshot
    // taken after a few minutes in a pocket legitimately omits the very row
    // the user unlocked the phone to see. Rebuilding from it wholesale would
    // delete a finished job the client is correctly holding. Running rows the
    // snapshot omits ARE gone and still drop out.
    for (const [id, prev] of map) {
      if (!next.has(id) && TERMINAL.has(prev.state)) next.set(id, prev);
    }
    return next;
  }
  if (ev.type === 'task.update' && ev.task && ev.task.id) {
    const next = new Map(map);
    const prev = map.get(ev.task.id);
    next.set(ev.task.id, prev && prev._fgSeen != null && prev.state === ev.task.state
      ? { ...ev.task, _fgSeen: prev._fgSeen } : ev.task);
    return next;
  }
  return map;
}

export function nextBackoff(ms) {
  return Math.min(Math.max(ms * 2, 1000), 15000);
}

// Terminal rows are pruned on FOREGROUND time, not wall time. A job that
// finishes while the PWA is backgrounded used to be pruned 60s later against
// the server's `updated` stamp — so it was gone before the screen came back
// on. The budget only starts once the row has actually been on screen.
export const TERMINAL_FOREGROUND_MS = 60_000;
const TERMINAL = new Set(['done', 'failed', 'interrupted']);

export function markSeen(map, fgMs, visible) {
  if (!visible) return map;
  let changed = false;
  const next = new Map();
  for (const [id, t] of map) {
    if (TERMINAL.has(t.state) && t._fgSeen == null) {
      next.set(id, { ...t, _fgSeen: fgMs });
      changed = true;
    } else next.set(id, t);
  }
  return changed ? next : map;
}

export function pruneTerminal(map, fgMs, budgetMs = TERMINAL_FOREGROUND_MS) {
  let changed = false;
  const next = new Map();
  for (const [id, t] of map) {
    if (TERMINAL.has(t.state) && t._fgSeen != null && fgMs - t._fgSeen > budgetMs) {
      changed = true;
      continue;
    }
    next.set(id, t);
  }
  return changed ? next : map;
}

let _map = new Map();
let _subs = new Set();
let _es = null;
let _backoff = 0;
let _booted = false;
let _pruneTimer = null;
// Milliseconds this document has been visible since boot. Wall time is the
// wrong clock for "has the user had a chance to see this".
let _fgMs = 0;
let _fgSince = null;

function _foregroundMs() {
  return _fgMs + (_fgSince == null ? 0 : Date.now() - _fgSince);
}

function _visible() {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function _list() {
  const arr = [..._map.values()];
  arr.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1)
    || (b.updated || 0) - (a.updated || 0));
  return arr;
}

function _notify() {
  const fg = _foregroundMs();
  _map = pruneTerminal(markSeen(_map, fg, _visible()), fg);
  const arr = _list();
  for (const cb of [..._subs]) {
    try { cb(arr); } catch (_) { /* one bad view can't break the feed */ }
  }
}

function _apply(ev) {
  const next = reduceFeedEvent(_map, ev);
  if (next !== _map) { _map = next; _notify(); }
}

// Fix round 1, finding 6 (task-w2a-report.md): connectionState() has always
// been correct the instant it's *read*, but nothing ever prompted a render
// when the tri-state actually CHANGED — health.js's "reconnecting…" copy
// (live/health.js, wired into the mobile chat header + More card since Task
// 2.2) only ever painted by coincidence, whenever some unrelated render
// happened to land afterwards. _notifyConnectionState() renders exactly once
// per real transition (idle/connected/reconnecting → a different one of
// those), never once per event — _lastConnState dedupes so a message on an
// already-open stream, or a redundant onerror, is a no-op here.
let _lastConnState = 'idle'; // mirrors connectionState()'s own pre-boot default
function _notifyConnectionState() {
  const cur = connectionState();
  if (cur === _lastConnState) return;
  _lastConnState = cur;
  try { runtime.render(); } catch (_) { /* no live app instance (e.g. under node:test) */ }
}

function _connect() {
  let es;
  try {
    es = new EventSource(STREAM, { withCredentials: true });
  } catch (_) { _reconnect(); return; }
  _es = es;
  // Covers a stub/polyfill whose readyState is already OPEN synchronously;
  // real browsers transition via the onopen handler below instead.
  _notifyConnectionState();
  es.onopen = () => {
    if (_es !== es) return;
    _notifyConnectionState();
  };
  es.onmessage = (e) => {
    if (_es !== es) return;
    _backoff = 0;
    let ev = null;
    try { ev = JSON.parse(e.data); } catch (_) { return; /* keepalive */ }
    _apply(ev);
  };
  es.onerror = () => {
    if (_es !== es) return;
    try { es.close(); } catch (_) {}
    _es = null;
    _notifyConnectionState();
    _reconnect();
  };
}

// Exported so the fallback-vs-stream race is testable at the logic level:
// _connect() sets _es synchronously before any fetch response could land, so
// by the time this fires we know whether a stream reconnected first.
export function shouldApplyFallback(streamAttached) { return !streamAttached; }

function _reconnect() {
  // One plain GET so a broken SSE still shows current state. Guarded: if the
  // stream reconnects and delivers a fresher snapshot before this fetch
  // resolves, applying this stale one would regress (e.g. a terminal task
  // back to running) with nothing to correct it client-side.
  fetch(FALLBACK, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { if (shouldApplyFallback(!!_es) && d) _apply({ type: 'tasks.snapshot', tasks: d.tasks }); })
    .catch(() => {});
  _backoff = nextBackoff(_backoff);
  const t = setTimeout(_connect, _backoff);
  if (t && typeof t.unref === 'function') t.unref();   // node tests: don't hold the loop
}

function _startPruneTimer() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(() => {
    const fg = _foregroundMs();
    const next = pruneTerminal(markSeen(_map, fg, _visible()), fg);
    if (next !== _map) { _map = next; _notify(); }
  }, 10_000);
  if (_pruneTimer && typeof _pruneTimer.unref === 'function') _pruneTimer.unref();
}

// iOS suspends a backgrounded PWA's EventSource without ever firing onerror,
// so the socket is dead but `_es` still looks attached and no reconnect is
// scheduled. Returning to the app is the only reliable signal we get: drop the
// socket unconditionally and reconnect immediately (no backoff — this is a
// fresh user-initiated resume, not a failing server).
//
// Fix round 1, F1: this used to also fire its own fetch(FALLBACK) here. That
// was redundant AND dangerous — /api/tasks/stream's handler yields a
// tasks.snapshot as the very first frame on connect (backend/tasks_route.py:
// _stream_gen), so _connect() alone already delivers a fresh snapshot. The
// manual fetch had no ordering guarantee against that stream snapshot: if it
// resolved second, it could overwrite a just-finished row with a stale
// `running` copy — the exact bug class this task exists to kill, reintroduced
// on this resume path. (shouldApplyFallback's guard doesn't save it either:
// _connect() sets _es synchronously, so the guard would just always be
// false — dead code that looks safe.) If the EventSource constructor itself
// throws, _connect() already falls back to _reconnect(), which does its own
// properly-guarded fetch.
function _onVisibilityChange() {
  if (_visible()) {
    if (_fgSince == null) _fgSince = Date.now();
    if (_es) { try { _es.close(); } catch (_) {} _es = null; }
    _backoff = 0;
    _notifyConnectionState();
    _connect();
  } else if (_fgSince != null) {
    _fgMs += Date.now() - _fgSince;
    _fgSince = null;
  }
}

// Connection tri-state for health-status callers (see live/health.js).
// Deliberately coarse: 'connected' once the stream socket is open, and
// 'reconnecting' any time it isn't but subscribeTasks() has booted (covers
// both the CONNECTING readyState and the gap between a dropped stream and
// its next _connect() attempt — _es is null there, mid-backoff).
// 'idle' before the first boot: no window/EventSource yet (e.g. node:test),
// so there's no evidence of a problem — currentHealth() treats it as online.
export function connectionState() {
  if (!_booted) return 'idle';
  if (_es && _es.readyState === 1) return 'connected'; // 1 = EventSource.OPEN
  return 'reconnecting';
}

export function subscribeTasks(cb) {
  _subs.add(cb);
  if (!_booted && typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
    _booted = true;
    _connect();
    _startPruneTimer();
    _fgSince = _visible() ? Date.now() : null;
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', _onVisibilityChange);
    }
  }
  try { cb(_list()); } catch (_) { /* view error isolated */ }
  return () => { _subs.delete(cb); };
}
