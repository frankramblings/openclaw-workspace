// Pure state transitions for the mobile edit-message flow. app.js wires
// these into the actions map with the real clearTimeout.

export function editPendingOnMobile(state, msgId, io) {
  const chat = state.live && state.live.chat;
  if (!chat || !chat.pendingSend) return;
  if (chat.pendingSend.messageId !== msgId) return;
  const { text, timerId } = chat.pendingSend;
  if (timerId) io.clearTimeout(timerId);
  const idx = chat.thread.findIndex((m) => m.id === msgId);
  if (idx >= 0) chat.thread.splice(idx, 1);
  state.draft = text || '';
  state.mobileEditingPending = { originalMsgId: msgId };
  chat.pendingSend = null;
  state.focus = 'mdraft';
}

export function cancelMobileEdit(state) {
  state.mobileEditingPending = null;
  state.draft = '';
  state.focus = null;
}
