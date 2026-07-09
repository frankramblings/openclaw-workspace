// Global error boundary: catches uncaught throws and unhandled promise
// rejections that would otherwise leave the SPA silently half-dead (see
// app.js's render() — a throw there used to escape into the console with
// nothing telling Frank the UI is now stuck). This module is DELIBERATELY
// split into a pure part (formatClientError — no DOM/window access, plain
// object in / plain object out) and a wiring part (installErrorBoundary —
// touches window, but every DOM handle it needs is injectable so tests never
// require a real browser).
//
// installErrorBoundary must NEVER throw, no matter what its `toast`/`post`
// callbacks do — an error boundary that itself crashes on a bad error would
// be worse than having none.

/** User-facing toast text (exact copy from the task brief). */
export const TOAST_MESSAGE = "Something broke in the UI — it's been logged. Reload if things look stuck.";

// Coalesce repeats of the *same* error (identical msg+src) seen within this
// window — a render() bug that throws on every keystroke would otherwise
// toast/post once per keystroke.
export const DEDUPE_WINDOW_MS = 30000;

// Hard cap on how many times we'll toast+post in one page session, even for
// DISTINCT errors — a cascade of different failures must not turn this into
// its own log-flood / toast-spam vector. Once hit we go quiet for the rest of
// the session (a reload resets it).
export const MAX_EVENTS_PER_SESSION = 10;

const CROSS_ORIGIN_NOISE = 'Script error.';

// Separator for the dedupe key (msg + src). Chosen only to avoid an
// accidental collision between e.g. msg="a" src="bc" and msg="ab" src="c";
// error messages/filenames containing this exact sequence are not a realistic
// concern for a de-dupe heuristic.
const KEY_SEP = '::';

function safeStr(v) {
  if (typeof v === 'string') return v;
  if (v == null) return String(v);
  try { return JSON.stringify(v); } catch (_) { return String(v); }
}

/**
 * Normalize a window `error` or `unhandledrejection` event into
 * {msg, src, stack}, or null when there's nothing actionable to report.
 *
 * Accepts anything duck-typed like the real browser events so it's testable
 * with plain object literals — no DOM required:
 *   - ErrorEvent-ish:            {message, filename, lineno, colno, error}
 *   - PromiseRejectionEvent-ish: {type: 'unhandledrejection', reason} (or
 *                                 just {reason: ...})
 *
 * Returns null for cross-origin "Script error." noise: browsers redact
 * everything about errors thrown by scripts loaded without CORS from another
 * origin down to that literal string with no filename/line/col — there is
 * nothing useful to log, so we drop it rather than posting empty noise.
 */
export function formatClientError(evt) {
  if (!evt || typeof evt !== 'object') return null;

  const isRejection = evt.type === 'unhandledrejection' || 'reason' in evt;
  if (isRejection) {
    const reason = evt.reason;
    const isErr = reason instanceof Error;
    const msg = isErr ? (reason.message || String(reason)) : safeStr(reason);
    if (!msg) return null;
    const stack = isErr ? (reason.stack || '') : '';
    return { msg, src: 'unhandledrejection', stack };
  }

  const rawMsg = evt.message != null ? String(evt.message) : '';
  if (rawMsg === CROSS_ORIGIN_NOISE) return null; // cross-origin noise — nothing actionable

  const msg = rawMsg || (evt.error && evt.error.message) || 'Unknown error';
  const src = evt.filename ? `${evt.filename}:${evt.lineno || 0}:${evt.colno || 0}` : '';
  const stack = (evt.error && evt.error.stack) || '';
  return { msg, src, stack };
}

/**
 * Wire window.onerror + unhandledrejection to a toast + a fire-and-forget
 * backend post, with dedupe and a session-wide rate cap.
 *
 * @param {Object} opts
 * @param {(msg: string) => void} [opts.toast] - shows the user-facing toast.
 *   If missing, or if calling it throws (e.g. it's not wired up yet during
 *   very early boot), falls back to console.error — the boundary itself must
 *   never throw because its notification path is unavailable.
 * @param {(payload: {msg, src, stack}) => void} [opts.post] - ships the
 *   formatted error to the backend (POST /api/client-log). Fire-and-forget;
 *   any throw/rejection is swallowed.
 * @param {{addEventListener: Function}} [opts.target] - defaults to `window`.
 *   Injectable so tests can drive this with a fake event target instead of a
 *   real browser.
 * @param {() => number} [opts.now] - defaults to Date.now. Injectable so
 *   dedupe-window tests don't need real timers.
 * @returns {{handle: Function}} the internal handler, exposed for tests that
 *   want to drive it directly instead of going through target.addEventListener.
 */
export function installErrorBoundary({ toast, post, target, now } = {}) {
  const win = target || (typeof window !== 'undefined' ? window : null);
  const clock = typeof now === 'function' ? now : Date.now;

  const lastHandledAt = new Map(); // dedupe key -> timestamp of last toast+post
  let eventCount = 0;

  function safeToast(msg) {
    try {
      if (typeof toast === 'function') { toast(msg); return; }
    } catch (_) { /* fall through to console.error below */ }
    try { console.error(msg); } catch (_) { /* nothing more we can do */ }
  }

  function safePost(payload) {
    try {
      if (typeof post === 'function') post(payload);
    } catch (_) { /* fire-and-forget — never let logging crash the app */ }
  }

  function handle(evt) {
    try {
      const info = formatClientError(evt);
      if (!info) return;
      if (eventCount >= MAX_EVENTS_PER_SESSION) return; // session cap reached — stay quiet

      const key = info.msg + KEY_SEP + info.src;
      const t = clock();
      const last = lastHandledAt.get(key);
      if (last != null && t - last < DEDUPE_WINDOW_MS) return; // coalesce duplicate

      lastHandledAt.set(key, t);
      eventCount += 1;
      safeToast(TOAST_MESSAGE);
      safePost(info);
    } catch (_) {
      // The boundary must NEVER throw, even on a genuinely malformed event.
      try { console.error('error-boundary: internal failure handling a client error'); } catch (_) { /* give up quietly */ }
    }
  }

  try {
    if (win && typeof win.addEventListener === 'function') {
      win.addEventListener('error', handle);
      win.addEventListener('unhandledrejection', handle);
    }
  } catch (_) { /* no usable event target (non-browser env) — degrade to a no-op */ }

  return { handle };
}
