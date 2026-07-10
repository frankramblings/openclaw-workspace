// Hardware/browser Back support for the mobile shell — pure layer model, no
// DOM. app.js keeps history depth in sync with derivedDepth() after every
// render (one pushState per open layer), and its popstate handler calls
// closeTopmost() until the state matches the entry landed on. Result: Back
// closes the top-most sheet / reader / sub-screen instead of exiting the PWA.
//
// Layers (top → bottom):
//   1. sheets (any of them — they're mutually exclusive in practice, and the
//      long-press message sheet lives in live.chat.mobileSheetMsgId)
//   2. readers (email reader, inbox reader overlay)
//   3. "More" sub-screen (calendar/research/library/notes/settings)

const anySheet = (s) => !!(
  s.companionSheetOpen || s.quickCaptureOpen || s.composeOpen
  || s.mConvSheetOpen || s.mModelSheetOpen || s.mDrawerOpen
  || (s.live && s.live.chat && s.live.chat.mobileSheetMsgId)
);
const anyReader = (s) => !!(s.mReader || s.inboxReader);

export function derivedDepth(s) {
  return (anySheet(s) ? 1 : 0) + (anyReader(s) ? 1 : 0) + (s.mSub ? 1 : 0);
}

// Close the single top-most layer in place. Returns true if something closed.
export function closeTopmost(s) {
  if (anySheet(s)) {
    s.companionSheetOpen = false;
    s.quickCaptureOpen = false;
    s.composeOpen = false;
    s.mConvSheetOpen = false;
    s.mModelSheetOpen = false;
    s.mDrawerOpen = false;
    if (s.live && s.live.chat) s.live.chat.mobileSheetMsgId = null;
    return true;
  }
  if (anyReader(s)) {
    s.mReader = false;
    s.inboxReader = null;
    return true;
  }
  if (s.mSub) {
    s.mSub = null;
    return true;
  }
  return false;
}
