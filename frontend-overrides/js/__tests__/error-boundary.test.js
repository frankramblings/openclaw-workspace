import { test } from 'node:test';
import assert from 'node:assert';
import {
  formatClientError, installErrorBoundary,
  TOAST_MESSAGE, DEDUPE_WINDOW_MS, MAX_EVENTS_PER_SESSION,
} from '../redesign/error-boundary.js';

// ---- formatClientError (pure) ----------------------------------------------

test('formatClientError: normal window error event -> {msg, src, stack}', () => {
  const evt = { message: 'x is not a function', filename: '/static/js/redesign/app.js', lineno: 42, colno: 7, error: { message: 'x is not a function', stack: 'TypeError: x is not a function\n  at render (app.js:42:7)' } };
  const info = formatClientError(evt);
  assert.deepStrictEqual(info, {
    msg: 'x is not a function',
    src: '/static/js/redesign/app.js:42:7',
    stack: 'TypeError: x is not a function\n  at render (app.js:42:7)',
  });
});

test('formatClientError: cross-origin "Script error." noise -> null', () => {
  const evt = { message: 'Script error.', filename: '', lineno: 0, colno: 0, error: null };
  assert.strictEqual(formatClientError(evt), null);
});

test('formatClientError: unhandledrejection with an Error reason', () => {
  const err = new Error('fetch failed');
  const evt = { type: 'unhandledrejection', reason: err };
  const info = formatClientError(evt);
  assert.strictEqual(info.msg, 'fetch failed');
  assert.strictEqual(info.src, 'unhandledrejection');
  assert.strictEqual(info.stack, err.stack);
});

test('formatClientError: unhandledrejection with a non-Error reason (string)', () => {
  const evt = { type: 'unhandledrejection', reason: 'boom' };
  const info = formatClientError(evt);
  assert.deepStrictEqual(info, { msg: 'boom', src: 'unhandledrejection', stack: '' });
});

test('formatClientError: unhandledrejection with an object reason stringifies', () => {
  const evt = { reason: { code: 'ECONNRESET' } };
  const info = formatClientError(evt);
  assert.strictEqual(info.src, 'unhandledrejection');
  assert.match(info.msg, /ECONNRESET/);
});

test('formatClientError: missing/garbage event -> null (never throws)', () => {
  assert.strictEqual(formatClientError(null), null);
  assert.strictEqual(formatClientError(undefined), null);
  assert.strictEqual(formatClientError('not an object'), null);
  assert.strictEqual(formatClientError(42), null);
});

test('formatClientError: no filename on an error event -> empty src, not a throw', () => {
  const evt = { message: 'weird error', filename: '', lineno: 0, colno: 0 };
  const info = formatClientError(evt);
  assert.deepStrictEqual(info, { msg: 'weird error', src: '', stack: '' });
});

test('formatClientError: an event with throwing getters -> null, never throws', () => {
  // The exported contract ("pure, callable from anywhere") must hold even
  // outside handle()'s own try/catch — e.g. a hostile/exotic event object.
  const evilError = {};
  Object.defineProperty(evilError, 'message', { get() { throw new Error('gotcha'); } });
  assert.strictEqual(formatClientError(evilError), null);

  const evilRejection = { type: 'unhandledrejection' };
  Object.defineProperty(evilRejection, 'reason', { get() { throw new Error('gotcha'); } });
  assert.strictEqual(formatClientError(evilRejection), null);
});

// ---- installErrorBoundary (wiring: dedupe / rate cap / never-throw) -------

function fakeTarget() {
  const listeners = {};
  return {
    listeners,
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener(type) { delete listeners[type]; },
  };
}

test('installErrorBoundary: wires both window events', () => {
  const target = fakeTarget();
  installErrorBoundary({ toast: () => {}, post: () => {}, target });
  assert.strictEqual(typeof target.listeners.error, 'function');
  assert.strictEqual(typeof target.listeners.unhandledrejection, 'function');
});

test('installErrorBoundary: toasts + posts once for a genuine error', () => {
  const target = fakeTarget();
  const toasts = [];
  const posts = [];
  installErrorBoundary({ toast: (m) => toasts.push(m), post: (p) => posts.push(p), target });
  target.listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1 });
  assert.deepStrictEqual(toasts, [TOAST_MESSAGE]);
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].msg, 'boom');
});

test('installErrorBoundary: cross-origin noise never toasts or posts', () => {
  const target = fakeTarget();
  const toasts = [];
  const posts = [];
  installErrorBoundary({ toast: (m) => toasts.push(m), post: (p) => posts.push(p), target });
  target.listeners.error({ message: 'Script error.', filename: '', lineno: 0, colno: 0 });
  assert.strictEqual(toasts.length, 0);
  assert.strictEqual(posts.length, 0);
});

test('installErrorBoundary: dedupes an identical msg+src within the window', () => {
  const target = fakeTarget();
  let t = 1000;
  const posts = [];
  installErrorBoundary({ toast: () => {}, post: (p) => posts.push(p), target, now: () => t });
  const evt = { message: 'boom', filename: 'a.js', lineno: 1, colno: 1 };
  target.listeners.error(evt);
  t += DEDUPE_WINDOW_MS - 1; // still inside the window
  target.listeners.error(evt);
  assert.strictEqual(posts.length, 1, 'the second identical error within the window is coalesced');
});

test('installErrorBoundary: re-fires once the dedupe window has passed', () => {
  const target = fakeTarget();
  let t = 1000;
  const posts = [];
  installErrorBoundary({ toast: () => {}, post: (p) => posts.push(p), target, now: () => t });
  const evt = { message: 'boom', filename: 'a.js', lineno: 1, colno: 1 };
  target.listeners.error(evt);
  t += DEDUPE_WINDOW_MS + 1; // outside the window
  target.listeners.error(evt);
  assert.strictEqual(posts.length, 2);
});

test('installErrorBoundary: a different src is NOT deduped against the first', () => {
  const target = fakeTarget();
  const posts = [];
  installErrorBoundary({ toast: () => {}, post: (p) => posts.push(p), target });
  target.listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1 });
  target.listeners.error({ message: 'boom', filename: 'b.js', lineno: 1, colno: 1 });
  assert.strictEqual(posts.length, 2);
});

test('installErrorBoundary: caps at MAX_EVENTS_PER_SESSION distinct events', () => {
  const target = fakeTarget();
  const posts = [];
  const toasts = [];
  installErrorBoundary({ toast: (m) => toasts.push(m), post: (p) => posts.push(p), target });
  for (let i = 0; i < MAX_EVENTS_PER_SESSION + 5; i++) {
    target.listeners.error({ message: `boom ${i}`, filename: 'a.js', lineno: i, colno: 1 });
  }
  assert.strictEqual(posts.length, MAX_EVENTS_PER_SESSION);
  assert.strictEqual(toasts.length, MAX_EVENTS_PER_SESSION);
});

test('installErrorBoundary: unhandledrejection listener also dedupes/posts', () => {
  const target = fakeTarget();
  const posts = [];
  installErrorBoundary({ toast: () => {}, post: (p) => posts.push(p), target });
  target.listeners.unhandledrejection({ type: 'unhandledrejection', reason: new Error('rejected') });
  assert.strictEqual(posts.length, 1);
  assert.strictEqual(posts[0].src, 'unhandledrejection');
});

test('installErrorBoundary: a throwing toast falls back to console.error, never crashes', () => {
  const target = fakeTarget();
  const posts = [];
  const originalError = console.error;
  const logged = [];
  console.error = (...args) => logged.push(args);
  try {
    installErrorBoundary({
      toast: () => { throw new Error('toast UI is not mounted yet'); },
      post: (p) => posts.push(p),
      target,
    });
    assert.doesNotThrow(() => {
      target.listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1 });
    });
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(posts.length, 1, 'post still fires even though toast blew up');
  assert.ok(logged.length >= 1, 'the failure fell back to console.error');
});

test('installErrorBoundary: missing toast/post never throws', () => {
  const target = fakeTarget();
  assert.doesNotThrow(() => {
    installErrorBoundary({ target });
    target.listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1 });
  });
});

test('installErrorBoundary: a throwing post is swallowed, never crashes', () => {
  const target = fakeTarget();
  assert.doesNotThrow(() => {
    installErrorBoundary({ toast: () => {}, post: () => { throw new Error('network down'); }, target });
    target.listeners.error({ message: 'boom', filename: 'a.js', lineno: 1, colno: 1 });
  });
});

test('installErrorBoundary: a garbage event (non-object) is swallowed, never throws', () => {
  const target = fakeTarget();
  const posts = [];
  installErrorBoundary({ toast: () => {}, post: (p) => posts.push(p), target });
  assert.doesNotThrow(() => {
    target.listeners.error(null);
    target.listeners.error(undefined);
    target.listeners.error(42);
  });
  assert.strictEqual(posts.length, 0);
});

test('installErrorBoundary: degrades to a no-op without a usable target (no crash at install time)', () => {
  assert.doesNotThrow(() => {
    installErrorBoundary({ toast: () => {}, post: () => {}, target: {} });
  });
});

// ---- synchronous reentrancy (regression pins for the bookkeeping order) ---
// The dedupe map entry and the eventCount increment happen BEFORE safeToast/
// safePost fire, so a toast callback that itself dispatches back into the
// boundary synchronously cannot double-fire or recurse unboundedly. These
// tests pin that ordering — a refactor that moves the bookkeeping after the
// callbacks would regress here, not silently in production.

test('installErrorBoundary: a toast that synchronously re-dispatches the SAME error fires exactly once', () => {
  const target = fakeTarget();
  const posts = [];
  let toasts = 0;
  const evt = { message: 'boom', filename: 'a.js', lineno: 1, colno: 1 };
  installErrorBoundary({
    // No recursion guard here on purpose: the dedupe entry is written before
    // this callback runs, so the nested dispatch must coalesce, not loop.
    toast: () => { toasts += 1; target.listeners.error(evt); },
    post: (p) => posts.push(p),
    target,
  });
  target.listeners.error(evt);
  assert.strictEqual(toasts, 1);
  assert.strictEqual(posts.length, 1);
});

test('installErrorBoundary: a toast that synchronously dispatches a NEW error each time is bounded by the session cap', () => {
  const target = fakeTarget();
  const posts = [];
  let toasts = 0;
  let n = 0;
  installErrorBoundary({
    toast: () => {
      toasts += 1;
      n += 1;
      // Distinct msg every time — dedupe can't stop this cascade, only the
      // session cap can (eventCount is incremented before we run).
      target.listeners.error({ message: `cascade ${n}`, filename: 'a.js', lineno: n, colno: 1 });
    },
    post: (p) => posts.push(p),
    target,
  });
  target.listeners.error({ message: 'cascade 0', filename: 'a.js', lineno: 0, colno: 1 });
  assert.strictEqual(toasts, MAX_EVENTS_PER_SESSION);
  assert.strictEqual(posts.length, MAX_EVENTS_PER_SESSION);
});
