// Pure decision core of reconcileTurn (live/chat.js) — extracted so the
// truth table is unit-testable without the DOM/network half.
//   input: {active, lastTurnStatus, hasLocalLive, localSessionMatches, localFresh}
//   → 'attach' | 'finalize-interrupted' | 'finalize-stale' | 'none'
// `localFresh` = a live SOURCE (POST reader or EventSource) is still attached
// AND frames arrived within the hb-gap window — i.e. the local turn is healthy,
// not just present.
export function reconcileDecision(input) {
  if (input.active) {
    // A HEALTHY local live turn for this session is already rendering the
    // server's turn — re-attaching would append a duplicate partial assistant
    // bubble and orphan the original with streaming:true forever. Only a
    // stale/dead local pipe (hb gap, closed ES) warrants a re-attach.
    if (input.hasLocalLive && input.localSessionMatches && input.localFresh) return 'none';
    return 'attach';
  }
  if (!input.hasLocalLive) return 'none';
  if (!input.localSessionMatches) return 'none';
  return input.lastTurnStatus === 'interrupted' ? 'finalize-interrupted' : 'finalize-stale';
}
