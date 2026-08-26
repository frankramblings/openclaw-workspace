// Pure decision core for the dropped-connection recovery path (live/chat.js).
// Extracted so the "should I recover the finished reply, or fall back to
// error+retry?" logic is unit-testable without the DOM/network half.
//
// The bug this guards: event_store owns the turn, not the POST reader. When the
// reader dies mid-turn ("connection dropped before a response arrived") the turn
// can still COMPLETE server-side. If the client blindly recalls the message and
// the user taps "Send to retry", a SECOND turn starts for a message the server
// already answered → the duplicate-bubble bug (two "Working…" blocks for one
// question). Before recalling, we ask server truth (/api/chat/turn) and only
// recover — pull the real reply, suppress the retry — when the turn finished
// CLEANLY. Anything ambiguous (still running, interrupted, unknown) falls back
// to today's error+recall, so a real retry is never swallowed.
//
//   input: {active, lastTurnStatus}  (the /api/chat/turn snapshot fields)
//   → true  = the turn ended cleanly server-side; pull the reply, skip retry
//   → false = ambiguous; keep today's error notice + recall behavior
//
// Mirrors reconcileTurn's finalize-stale test: a non-'interrupted' terminal
// status is a normal completion. `active` (still running) is never recoverable
// here — a retry into an active turn hits busy_stream server-side, no dup.
export function shouldRecoverDroppedTurn(snap) {
  if (!snap || snap.active) return false;
  const status = snap.last_turn && snap.last_turn.status;
  if (!status || status === 'interrupted') return false;
  return true;
}

// Full triage for a statusless mid-turn connection drop. The reader dying does
// NOT mean the turn died — event_store owns the turn, not the POST reader. Three
// outcomes:
//   'reattach' — the turn is STILL RUNNING server-side: re-attach to the live
//                event_store tail and keep streaming. This is the case that was
//                missing — it used to fall through to error+recall, abandoning
//                the partial reply the user was reading ("streaming then
//                disappears").
//   'recover'  — the turn FINISHED cleanly while our reader was dead: pull the
//                real reply from server truth, suppress the retry (no dup turn).
//   'error'    — ambiguous (interrupted / unknown / no snapshot): keep today's
//                error notice + recall so a genuine resend is never swallowed.
export function droppedTurnAction(snap) {
  if (snap && snap.active) return 'reattach';
  if (shouldRecoverDroppedTurn(snap)) return 'recover';
  return 'error';
}
