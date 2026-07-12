// Pure state transitions for the mobile edit-message flow. app.js wires
// these into the actions map with the real clearTimeout.

// Fresh grace window granted to a send restored by Cancel — mirrors
// live/chat.js's BUFFER_MS (kept as a local constant, not imported: this
// module stays import-safe/pure with no browser-touching transitive
// dependencies, which live/chat.js is not — see __tests__/edit-flow.test.js).
const GRACE_MS = 700;

const DEFAULT_IO = { setTimeout: (fn, ms) => setTimeout(fn, ms) };

export function editPendingOnMobile(state, msgId, io) {
  const chat = state.live && state.live.chat;
  if (!chat || !chat.pendingSend) return;
  if (chat.pendingSend.messageId !== msgId) return;
  const { text, timerId, attachSnap, sessionId } = chat.pendingSend;
  if (timerId) io.clearTimeout(timerId);
  const idx = chat.thread.findIndex((m) => m.id === msgId);
  let originalMsg = null;
  if (idx >= 0) originalMsg = chat.thread.splice(idx, 1)[0] || null;
  // Snapshot everything Cancel needs to put the message back exactly where
  // it was — bubble, position, and the pendingSend fields the network send
  // still needs — plus whatever the user had already typed into the draft
  // box before tapping Edit, since editing is about to clobber it below.
  state.mobileEditingPending = {
    originalMsgId: msgId,
    originalIndex: idx,
    originalMsg,
    pending: { messageId: msgId, text, attachSnap, sessionId },
    priorDraft: state.draft || '',
  };
  state.draft = text || '';
  chat.pendingSend = null;
  state.focus = 'mdraft';
}

// Cancel must undo editPendingOnMobile, not just wipe the draft: the bubble
// goes back into the thread at its original spot, the send is re-armed with
// a fresh grace window (io.setTimeout — desktop parity, the message still
// sends), and the draft reverts to whatever the user had typed before they
// tapped Edit (not emptied).
//
// io is optional: the app.js call site (`cancelMobileEdit: () =>
// cancelMobileEdit(state)`) passes none today, so this falls back to the
// real global setTimeout. That default arms a timer but has no `io.flush`
// to call when it fires — wiring a real flush callback through requires
// app.js (out of scope here; see task report).
export function cancelMobileEdit(state, io = DEFAULT_IO) {
  const pend = state.mobileEditingPending;
  if (pend) {
    const chat = state.live && state.live.chat;
    if (chat && pend.originalMsg) {
      const idx = Math.max(0, Math.min(pend.originalIndex, chat.thread.length));
      const deadline = Date.now() + GRACE_MS;
      chat.thread.splice(idx, 0, { ...pend.originalMsg, _optimistic: true, _deadline: deadline });
      if (pend.pending) {
        const timerId = io.setTimeout(() => {
          if (typeof io.flush === 'function') io.flush(pend.pending.sessionId);
        }, GRACE_MS);
        chat.pendingSend = { ...pend.pending, deadline, timerId };
      }
    }
    state.draft = pend.priorDraft || '';
  } else {
    state.draft = '';
  }
  state.mobileEditingPending = null;
  state.focus = null;
}

export function commitMobileEditIfPending(state) {
  if (state.mobileEditingPending) state.mobileEditingPending = null;
}
