// Pure decision core of reconcileTurn (live/chat.js) — extracted so the
// truth table is unit-testable without the DOM/network half.
//   input: {active, lastTurnStatus, hasLocalLive, localSessionMatches}
//   → 'attach' | 'finalize-interrupted' | 'finalize-stale' | 'none'
export function reconcileDecision(input) {
  if (input.active) return 'attach';
  if (!input.hasLocalLive) return 'none';
  if (!input.localSessionMatches) return 'none';
  return input.lastTurnStatus === 'interrupted' ? 'finalize-interrupted' : 'finalize-stale';
}
