// Pure long-press state machine. Injectable timer/dispatch so Node tests can
// drive it without a DOM. Wired to real pointer events by app.js.

const THRESHOLD_MS = 500;
const MOVE_CANCEL_PX = 8;

// `evt.action`/`evt.arg` let a second surface (the conversation drawer's rows)
// reuse this machine; both default to the original message-sheet behavior so
// existing callers pass `{ msgId }` unchanged.
export function startLongPress(state, evt, io) {
  resetLongPress(state, io);
  const active = {
    action: evt.action || 'openMobileMsgSheet',
    arg: evt.arg === undefined ? evt.msgId : evt.arg,
    msgId: evt.msgId,
    x: evt.x,
    y: evt.y,
  };
  active.timer = io.setTimer(() => {
    io.dispatch(active.action, active.arg);
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

// ---- click-swallow gate ------------------------------------------------
// A long-press that opens a sheet on release must eat the synthetic `click`
// the browser dispatches right after — otherwise the tap target's normal
// click handler ALSO fires underneath the sheet that just opened (e.g. the
// center "+" button: long-press opens quick-capture, but the follow-up click
// used to still fire "new chat", which closed the sheet it had just opened
// AND started a fresh thread). The window used to be a fixed timer measured
// from the moment the long-press fired; holding past it meant the release
// click landed unguarded. The swallow must instead last until the ACTUAL
// pointerup — an arbitrarily long hold is fine — then disarm itself shortly
// after so a later, unrelated tap isn't eaten too.
export function armSwallow(gate) {
  gate.swallowClick = true;
}

export function shouldSwallowClick(gate) {
  return !!(gate && gate.swallowClick);
}

// Call once on pointerup/pointercancel while armed. Disarms on a deferred
// tick rather than immediately: the browser dispatches `click` synchronously
// right after pointerup, in the same task, so clearing the flag straight
// away would race it closed before the click that pointerup itself produced
// ever arrives.
export function scheduleSwallowDisarm(gate, io) {
  if (!gate || !gate.swallowClick) return;
  io.setTimer(() => { gate.swallowClick = false; }, 0);
}
