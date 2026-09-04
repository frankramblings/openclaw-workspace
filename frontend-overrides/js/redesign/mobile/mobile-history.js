// Hardware/browser Back support for the mobile shell — pure layer model, no
// DOM. app.js keeps history depth in sync with derivedDepth() after every
// render (one pushState per open layer), and its popstate handler calls
// closeTopmost() until the state matches the entry landed on. Result: Back
// closes the top-most sheet / reader / sub-screen instead of exiting the PWA.
//
// Layers are closed ONE AT A TIME, top → bottom, in this priority order:
//   1. the inbox snooze sheet (inboxSnoozeFor)
//   2. the thread-actions sheet (live.chat.mobileConvSheetId)
//   3. the long-press message-tools sheet (live.chat.mobileSheetMsgId)
//   3. the quick-capture sheet
//   4. the compose sheet
//   5. a reader (email reader / inbox reader overlay)
//   6. the model picker sheet
//   7. the companion sheet
//   8. the conversation drawer
//   9. a pushed "More" sub-screen (calendar/research/library/notes/settings)
// The original design bucketed every sheet flag together as a single layer,
// so closeTopmost cleared ALL of them in one call whenever more than one
// happened to be set — reachable via the edge-swipe conversation drawer,
// which used to open right over an already-open compose sheet / inbox reader
// / message-tools sheet. edgeSwipeBlocked() below stops that combination
// from arising through the gesture; the per-layer ordering here makes
// closeTopmost correct regardless.
// Layers 5-7 used to be one more bucket ("drawer/model group", closed
// together by a single closeTopmost() call) protected only by the convention
// that at most one of the three was ever open at once — nothing enforced
// that. Split into three individual entries so one Back always closes
// exactly one flag, same as every other layer here.

const hasMsgSheet = (s) => !!(s.live && s.live.chat && s.live.chat.mobileSheetMsgId);
// The per-thread actions sheet (drawer row "⋯" / long-press). Sits ABOVE the
// message sheet in the stack: it is opened from the drawer, which can itself
// be open underneath, so Back must peel it off on its own.
const hasConvSheet = (s) => !!(s.live && s.live.chat && s.live.chat.mobileConvSheetId);
const hasReader = (s) => !!(s.mReader || s.inboxReader);
const hasSnoozeSheet = (s) => !!s.inboxSnoozeFor;

// Ordered top → bottom. `has` tests whether the layer is open; `close` clears
// it. closeTopmost() closes exactly the first matching entry per call.
const LAYERS = [
  // The inbox snooze bottom sheet (⏰ tap / left-swipe → live/inbox.js's
  // `snooze` action, shared with desktop's inline popover) — the newest,
  // most transient overlay, so it closes first, same reasoning as the
  // message-tools sheet below it.
  { has: hasSnoozeSheet, close: (s) => { s.inboxSnoozeFor = null; } },
  { has: hasConvSheet, close: (s) => { s.live.chat.mobileConvSheetId = null; } },
  { has: hasMsgSheet, close: (s) => { s.live.chat.mobileSheetMsgId = null; } },
  { has: (s) => !!s.quickCaptureOpen, close: (s) => { s.quickCaptureOpen = false; } },
  { has: (s) => !!s.composeOpen, close: (s) => { s.composeOpen = false; } },
  { has: hasReader, close: (s) => { s.mReader = false; s.inboxReader = null; } },
  { has: (s) => !!s.mModelSheetOpen, close: (s) => { s.mModelSheetOpen = false; } },
  { has: (s) => !!s.companionSheetOpen, close: (s) => { s.companionSheetOpen = false; } },
  { has: (s) => !!s.mDrawerOpen, close: (s) => { s.mDrawerOpen = false; } },
  { has: (s) => !!s.mSub, close: (s) => { s.mSub = null; } },
];

export function derivedDepth(s) {
  return LAYERS.reduce((n, layer) => n + (layer.has(s) ? 1 : 0), 0);
}

// Close the single top-most layer in place. Returns true if something closed.
export function closeTopmost(s) {
  for (const layer of LAYERS) {
    if (layer.has(s)) { layer.close(s); return true; }
  }
  return false;
}

// True while a layer that must never sit UNDER the edge-swipe conversation
// drawer holds the gesture surface — mobile-app.js consults this before
// arming an open-swipe from the screen edge. Deliberately broader than the
// drawer/model/companion trio itself: capture, compose, a reader, or the
// message-tools sheet must all block the drawer too (an up keyboard already
// owns the gesture layer). Shares the same layer predicates as derivedDepth/
// closeTopmost above so the gesture guard and the Back-stack model can never
// drift apart.
export function edgeSwipeBlocked(s) {
  return !!(
    s.quickCaptureOpen || s.composeOpen || s.keyboard
    || hasReader(s) || hasMsgSheet(s) || hasConvSheet(s) || hasSnoozeSheet(s)
    || s.mDrawerOpen || s.mModelSheetOpen || s.companionSheetOpen
  );
}

// ---- mobile shell latch -----------------------------------------------------
// Decide ONCE at boot whether this page load gets the mobile shell. Pure so
// app.js can compute it a single time and memoize the result — previously
// the shell picker was live `matchMedia('(max-width: 768px)').matches`,
// re-evaluated on every render. An iPhone rotated to landscape (844-932px)
// crosses back OVER that breakpoint mid-session, which silently swapped in
// the desktop shell while mobile-history's pushed `ocUi` history entries
// (which only exist/settle while isMobile() reads true) were stranded —
// leaving `_uiDepth` ahead of the real layer count once portrait returned, so
// the next hardware Back closed one MORE history entry than there were open
// layers and exited the PWA with a sheet still open. A touch-capable device
// with a coarse pointer is a phone regardless of its current width (neither
// signal changes on rotation); a narrow window at BOOT (e.g. a resized
// desktop browser) also gets the mobile shell, but — like the touch signal —
// that decision is never revisited after boot.
//
// `touchCeiling` bounds the coarse+touch signal to <=1024px. Without it, ANY
// coarse+touch device latched mobile at any width — an iPad in landscape
// (1024-1194px, genuinely coarse+touch) would be stuck on the phone UI for
// the rest of the session. Deliberate, narrow tradeoff for a single-user
// iPhone deployment: nothing legitimate here is coarse+touch AND wider than
// an iPad's landscape width, so drawing the line at 1024 costs nothing real
// while closing the iPad-landscape case. A width narrower than the plain
// `breakpoint` still latches regardless of pointer/touch (the resized-desktop-
// window case above), and an unknown width (not passed) doesn't get bounded —
// there's nothing to bound it against.
export function computeMobileLatch({ coarsePointer, touchCapable, width, breakpoint = 768, touchCeiling = 1024 } = {}) {
  const coarseTouch = !!(coarsePointer && touchCapable);
  const withinTouchCeiling = typeof width !== 'number' || width <= touchCeiling;
  return (coarseTouch && withinTouchCeiling) || (typeof width === 'number' && width <= breakpoint);
}
