// Hardware/browser Back support for the mobile shell — pure layer model, no
// DOM. app.js keeps history depth in sync with derivedDepth() after every
// render (one pushState per open layer), and its popstate handler calls
// closeTopmost() until the state matches the entry landed on. Result: Back
// closes the top-most sheet / reader / sub-screen instead of exiting the PWA.
//
// Layers are closed ONE AT A TIME, top → bottom, in this priority order:
//   1. the long-press message-tools sheet (live.chat.mobileSheetMsgId)
//   2. the quick-capture sheet
//   3. the compose sheet
//   4. a reader (email reader / inbox reader overlay)
//   5. the conversation drawer / model sheet / companion sheet
//   6. a pushed "More" sub-screen (calendar/research/library/notes/settings)
// The original design bucketed every sheet flag together as a single layer,
// so closeTopmost cleared ALL of them in one call whenever more than one
// happened to be set — reachable via the edge-swipe conversation drawer,
// which used to open right over an already-open compose sheet / inbox reader
// / message-tools sheet. edgeSwipeBlocked() below stops that combination
// from arising through the gesture; the per-layer ordering here makes
// closeTopmost correct regardless.

const hasMsgSheet = (s) => !!(s.live && s.live.chat && s.live.chat.mobileSheetMsgId);
const hasReader = (s) => !!(s.mReader || s.inboxReader);
const hasDrawerGroup = (s) => !!(s.mDrawerOpen || s.mModelSheetOpen || s.companionSheetOpen || s.mConvSheetOpen);

// Ordered top → bottom. `has` tests whether the layer is open; `close` clears
// it. closeTopmost() closes exactly the first matching entry per call.
const LAYERS = [
  { has: hasMsgSheet, close: (s) => { s.live.chat.mobileSheetMsgId = null; } },
  { has: (s) => !!s.quickCaptureOpen, close: (s) => { s.quickCaptureOpen = false; } },
  { has: (s) => !!s.composeOpen, close: (s) => { s.composeOpen = false; } },
  { has: hasReader, close: (s) => { s.mReader = false; s.inboxReader = null; } },
  { has: hasDrawerGroup, close: (s) => { s.mDrawerOpen = false; s.mModelSheetOpen = false; s.companionSheetOpen = false; s.mConvSheetOpen = false; } },
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
// drawer/model/companion group itself: capture, compose, a reader, or the
// message-tools sheet must all block the drawer too (an up keyboard already
// owns the gesture layer). Shares the same layer predicates as derivedDepth/
// closeTopmost above so the gesture guard and the Back-stack model can never
// drift apart.
export function edgeSwipeBlocked(s) {
  return !!(
    s.quickCaptureOpen || s.composeOpen || s.keyboard
    || hasReader(s) || hasMsgSheet(s) || hasDrawerGroup(s)
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
export function computeMobileLatch({ coarsePointer, touchCapable, width, breakpoint = 768 } = {}) {
  return !!(coarsePointer && touchCapable) || (typeof width === 'number' && width <= breakpoint);
}
