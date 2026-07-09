// Pure focus-trap logic for the redesign's modal/sheet surfaces (compose
// overlay, inbox reader, mobile bottom sheets, the conversation drawer, the
// image lightbox). No DOM APIs are called directly here — everything the
// module needs is either passed in or covered by a swappable predicate — so
// it's fully testable under node:test without a DOM (see
// frontend-overrides/js/__tests__/focus-trap.test.js).
//
// DOM wiring (querying the live container, calling .focus(), listening for
// Tab/Escape) stays in the surface modules (app.js's central keydown
// listener, image-viewer.js) — this module only computes "what's the tab
// order" and "given the order + where you are, where do you go next".

// Default focusable predicate — matches real DOM elements. Kept separate
// from trapOrder's traversal so tests can inject a plain-object predicate
// instead and pass plain arrays of mock "elements" with no DOM involved.
export function defaultIsFocusable(el) {
  if (!el) return false;
  if (el.hidden) return false;
  if (el.disabled) return false;
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  if (typeof el.tabIndex === 'number' && el.tabIndex < 0) return false;
  const tag = (el.tagName || '').toLowerCase();
  if (tag === 'a' || tag === 'area') return !!el.href;
  if (tag === 'button' || tag === 'select' || tag === 'textarea') return true;
  if (tag === 'input') return (el.type || 'text').toLowerCase() !== 'hidden';
  if (el.isContentEditable) return true;
  if (el.hasAttribute && el.hasAttribute('tabindex')) return true;
  return false;
}

// trapOrder(container, isFocusable = defaultIsFocusable) -> element[]
//
// `container` is either:
//   - a real DOM node (or anything exposing `.querySelectorAll('*')`), in
//     which case every descendant is walked and filtered by `isFocusable`; or
//   - an array-like of candidate elements (a NodeList, or — for tests — a
//     plain array of mock element objects), used as-is and filtered.
//
// The returned order follows document/array order, which matches native tab
// order for the flat, non-tabindex-authored markup this codebase uses (no
// element here sets a positive tabindex to reorder itself ahead of others).
export function trapOrder(container, isFocusable = defaultIsFocusable) {
  const candidates = container && typeof container.querySelectorAll === 'function'
    ? Array.from(container.querySelectorAll('*'))
    : Array.from(container || []);
  return candidates.filter(isFocusable);
}

// pickModal(surfaces, state, exists) -> surface | null
//
// Walks an ordered modal registry (first match wins — callers order it by
// paint/z-order) and returns the first surface whose `open(state)` predicate
// is true AND whose container actually exists right now, per the injected
// `exists(selector)` predicate (DOM-independent here; app.js passes a
// document.querySelector check). The existence check is the point: a modal's
// state flag can outlive its container — e.g. state.inboxReader staying set
// while the user navigates to a surface that doesn't render the reader — and
// without it Escape/Tab handling would silently target a dead surface while
// shadowing lower open modals. Omitting `exists` skips the check (pure
// state-flag behavior).
export function pickModal(surfaces, state, exists) {
  for (const m of surfaces || []) {
    if (!m.open(state)) continue;
    if (exists && !exists(m.selector)) continue;
    return m;
  }
  return null;
}

// nextFocus(list, current, shift) -> element | null
//
// Steps to the next (or, if `shift` is true, previous) entry in `list`,
// wrapping around at either end — the core Tab / Shift+Tab behavior of a
// focus trap. If `current` isn't in `list` (nothing focused yet, or focus
// was outside the trap), lands on the first element going forward or the
// last element going backward, so the very first Tab press always lands
// somewhere sane. Returns null for an empty list.
export function nextFocus(list, current, shift) {
  if (!Array.isArray(list) || list.length === 0) return null;
  const idx = list.indexOf(current);
  if (idx === -1) return shift ? list[list.length - 1] : list[0];
  const step = shift ? -1 : 1;
  const nextIdx = (idx + step + list.length) % list.length;
  return list[nextIdx];
}
