// The ONE consumer of /api/tasks/stream. Every progress surface (in-chat
// task rows, the jobs overlay, anything future) subscribes here instead of
// owning its own transport — one EventSource, one backoff policy, one
// GET-fallback, applied once (this replaces task-rows' 1s polling and the
// overlay's private stream).
//
// Pure parts (reduceFeedEvent, nextBackoff, pruneTerminal) are exported for
// node:test.

const STREAM = '/api/tasks/stream';
const FALLBACK = '/api/tasks';

export function reduceFeedEvent(map, ev) {
  if (!ev || typeof ev !== 'object') return map;
  if (ev.type === 'tasks.snapshot' && Array.isArray(ev.tasks)) {
    const next = new Map();
    for (const t of ev.tasks) if (t && t.id) next.set(t.id, t);
    return next;
  }
  if (ev.type === 'task.update' && ev.task && ev.task.id) {
    const next = new Map(map);
    next.set(ev.task.id, ev.task);
    return next;
  }
  return map;
}

export function nextBackoff(ms) {
  return Math.min(Math.max(ms * 2, 1000), 15000);
}

// The delta protocol has no removal signal: a done/failed/interrupted task
// just stops changing. Without pruning, terminal records would accumulate
// forever (done cards lingering in every view until reload). `updated` is
// the registry's epoch-ms timestamp; we compare it against the client's
// Date.now(), which assumes roughly-synced clocks — fine since the same
// host serves the page and the API.
export const TERMINAL_TTL_MS = 60_000;
const TERMINAL = new Set(['done', 'failed', 'interrupted']);

export function pruneTerminal(map, nowMs, ttlMs = TERMINAL_TTL_MS) {
  let changed = false;
  const next = new Map();
  for (const [id, t] of map) {
    if (TERMINAL.has(t.state) && nowMs - (t.updated || 0) > ttlMs) { changed = true; continue; }
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

function _list() {
  const arr = [..._map.values()];
  arr.sort((a, b) => (a.state === 'running' ? 0 : 1) - (b.state === 'running' ? 0 : 1)
    || (b.updated || 0) - (a.updated || 0));
  return arr;
}

function _notify() {
  _map = pruneTerminal(_map, Date.now());
  const arr = _list();
  for (const cb of [..._subs]) {
    try { cb(arr); } catch (_) { /* one bad view can't break the feed */ }
  }
}

function _apply(ev) {
  const next = reduceFeedEvent(_map, ev);
  if (next !== _map) { _map = next; _notify(); }
}

function _connect() {
  let es;
  try {
    es = new EventSource(STREAM, { withCredentials: true });
  } catch (_) { _reconnect(); return; }
  _es = es;
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
    _reconnect();
  };
}

function _reconnect() {
  // One plain GET so a broken SSE still shows current state.
  fetch(FALLBACK, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => d && _apply({ type: 'tasks.snapshot', tasks: d.tasks }))
    .catch(() => {});
  _backoff = nextBackoff(_backoff);
  const t = setTimeout(_connect, _backoff);
  if (t && typeof t.unref === 'function') t.unref();   // node tests: don't hold the loop
}

function _startPruneTimer() {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(() => {
    const next = pruneTerminal(_map, Date.now());
    if (next !== _map) { _map = next; _notify(); }
  }, 10_000);
  if (_pruneTimer && typeof _pruneTimer.unref === 'function') _pruneTimer.unref();
}

export function subscribeTasks(cb) {
  _subs.add(cb);
  if (!_booted && typeof window !== 'undefined' && typeof EventSource !== 'undefined') {
    _booted = true;
    _connect();
    _startPruneTimer();
  }
  try { cb(_list()); } catch (_) { /* view error isolated */ }
  return () => { _subs.delete(cb); };
}
