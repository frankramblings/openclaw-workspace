// Pure helpers for closing the mobile message action sheet. app.js wires
// these to real touch events and to the post-dispatch close hook.

const SWIPE_MIN_DY = 60;
const SWIPE_MAX_MS = 400;

export function shouldSwipeDismiss({ dy, dtMs }) {
  return dy >= SWIPE_MIN_DY && dtMs <= SWIPE_MAX_MS;
}

export function applyCloseSheet(state, flag) {
  if (!flag) return;
  if (!state.live || !state.live.chat) return;
  state.live.chat.mobileSheetMsgId = null;
}

// Pure first half of the animated-close sequence: marks a sheet as "closing"
// (still rendered, now carrying an exit class) without touching its open flag.
// The caller owns the timed second half (flip openFlag false + re-render after
// the exit animation's duration) since only the caller has access to
// runtime.render/setTimeout — this function stays DOM/timer-free so it's
// unit-testable and so a double-tap on the scrim can't re-arm a second timer
// (guarded via the closing flag itself, not a module-level timer id).
export function startClosingSheet(state, openFlag, closingFlag) {
  if (!state[openFlag] || state[closingFlag]) return;
  state[closingFlag] = true;
}

// Matches the CSS exit-animation duration (mobile.css .m-sheet.closing /
// .m-scrim.closing). Pure decision for how long the animated-close timeout
// should wait before actually unmounting a sheet: the full CSS exit-animation
// duration under normal motion, or 0 under reduced motion (where the CSS
// animation's duration token already resolves to 0ms, so the visual close is
// instant — waiting the normal 200ms anyway would leave an invisible,
// still-mounted scrim swallowing taps for 200ms after the sheet appears gone).
const CLOSE_ANIM_MS = 200;
export function closeAnimMs(prefersReducedMotion) {
  return prefersReducedMotion ? 0 : CLOSE_ANIM_MS;
}
