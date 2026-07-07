// think-tag-state.js — incremental <think>/</think> tracking for the stream loop.
//
// WHY: the streaming reader used to call `accumulated.includes('<think>')`
// (three times) on EVERY delta, before the background-thread skip. `accumulated`
// grows with the whole message, so those scans are O(n) per delta => O(n²) over
// a stream, and they ran for backgrounded threads too. With several agent/
// research threads churning at once that O(n²) work piled onto the main thread
// and starved keystroke handling (type slow, then a burst of characters).
//
// This tracks the same two facts — "has an opening <think> appeared" and "has a
// closing </think> appeared" — with booleans that only flip false->true, updated
// by scanning ONLY the new delta plus a 7-char carry tail (so a tag split across
// two deltas is still caught). O(delta) per call, no full-message rescan.
//
// Pure module, no DOM deps, so it is unit-testable under `node --test`.

// Longest tag we look for is '</think>' (8 chars); carry 7 chars so a tag
// straddling the previous delta boundary is still found in `tail + delta`.
const CARRY = 7;

export function newThinkTagState() {
  return { sawOpen: false, sawClose: false, tail: '' };
}

/**
 * Apply the same <think>-wrapping the old inline code did and advance `state`.
 *
 * Mirrors the original per-delta logic exactly:
 *   if (isThinking) { if (!sawOpen) delta = '<think>' + delta; }
 *   else if (sawOpen && !sawClose) { delta = '</think>' + delta; }
 * where sawOpen/sawClose reflect `accumulated` BEFORE this delta is appended.
 *
 * @param {{sawOpen:boolean, sawClose:boolean, tail:string}} state - mutated in place
 * @param {string} delta - the raw json.delta for this chunk
 * @param {boolean} isThinking - json.thinking flag for this chunk
 * @returns {string} the (possibly tag-prefixed) delta to append to accumulated
 */
export function advanceThinkTags(state, delta, isThinking) {
  let out = delta;
  if (isThinking) {
    if (!state.sawOpen) out = '<think>' + out;
  } else if (state.sawOpen && !state.sawClose) {
    out = '</think>' + out;
  }
  // Update flags from only the newly-appended text (+ carry tail for split tags).
  const scan = state.tail + out;
  if (!state.sawOpen && scan.includes('<think>')) state.sawOpen = true;
  if (!state.sawClose && scan.includes('</think>')) state.sawClose = true;
  state.tail = scan.length > CARRY ? scan.slice(-CARRY) : scan;
  return out;
}
