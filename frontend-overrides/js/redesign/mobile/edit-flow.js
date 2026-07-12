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
// Session guard: the user can switch conversations mid-edit, after which
// chat.thread (and pendingSend's flush path) belong to a DIFFERENT session —
// splicing the bubble back would misfile it into whatever thread is on
// screen. When the snapshot's session isn't the active one, the message is
// routed to chat's session-keyed queue instead (io.queue → live/chat.js
// queueForSession, which also toasts; a direct queuedList push when no hook
// is wired) and fires through the normal queue plumbing when its own thread
// is next active. Safe because queuedList entries only ever fire into their
// own session (flushQueuedFor / flushPending's view gate).
//
// io is optional: the app.js call site wires { setTimeout, flush, queue };
// the bare default arms a timer with no flush/queue to call (see app.js).
export function cancelMobileEdit(state, io = DEFAULT_IO) {
  const pend = state.mobileEditingPending;
  // Double-fired Cancel (ghost tap, stale handler): the first call already
  // restored everything — a second must be inert, not wipe the draft the
  // first call just put back (or whatever the user typed since).
  if (!pend) return;
  const chat = state.live && state.live.chat;
  const sid = pend.pending ? pend.pending.sessionId : null;
  if (chat && pend.pending && sid != null && chat.activeId !== sid) {
    if (typeof io.queue === 'function') {
      io.queue(sid, pend.pending.text, pend.pending.attachSnap);
    } else {
      chat.queuedList = [...(chat.queuedList || []),
        { sid, text: pend.pending.text, attachSnap: pend.pending.attachSnap }];
    }
  } else if (chat && pend.originalMsg) {
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
  state.mobileEditingPending = null;
  state.focus = null;
}

export function commitMobileEditIfPending(state) {
  if (state.mobileEditingPending) state.mobileEditingPending = null;
}
