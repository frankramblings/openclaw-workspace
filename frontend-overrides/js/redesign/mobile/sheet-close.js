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
