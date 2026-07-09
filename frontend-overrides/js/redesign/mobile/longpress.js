// Pure long-press state machine. Injectable timer/dispatch so Node tests can
// drive it without a DOM. Wired to real pointer events by app.js.

const THRESHOLD_MS = 500;
const MOVE_CANCEL_PX = 8;

export function startLongPress(state, evt, io) {
  resetLongPress(state, io);
  const active = { msgId: evt.msgId, x: evt.x, y: evt.y };
  active.timer = io.setTimer(() => {
    io.dispatch('openMobileMsgSheet', active.msgId);
    state.active = null;
  }, THRESHOLD_MS);
  state.active = active;
}

export function moveLongPress(state, evt, io) {
  const a = state.active;
  if (!a) return;
  const dx = evt.x - a.x;
  const dy = evt.y - a.y;
  if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) {
    resetLongPress(state, io);
  }
}

export function endLongPress(state, io) {
  resetLongPress(state, io);
}

export function resetLongPress(state, io) {
  if (state.active) {
    io.clearTimer(state.active.timer);
    state.active = null;
  }
}
