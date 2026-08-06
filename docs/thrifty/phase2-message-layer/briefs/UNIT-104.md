# UNIT-104 — useStickToBottom + jump pill

## Objective
Streaming scroll that never fights the user: stick-to-bottom hook + pill.

## Inputs / context
- CONTRACT.md Scroll interface (binding). Spec decision 5 (no
  overflow-anchor; iOS is the target).
- Find the ACTUAL scrolling element for the chat thread: start at
  `src/tabs/chat/Thread.tsx` (45 lines) and its parent in `index.tsx`;
  report which element scrolls.

## Approach
- Hook `useStickToBottom(ref)`: pinned = within 40 px of bottom. Track via
  scroll events (passive) + `touchstart` (user intent unpins immediately if
  they drag up). Re-pin on content growth ONLY when pinned: MutationObserver
  (childList+subtree+characterData) on the scroll content → rAF-batched
  `scrollTop = scrollHeight`. `jumpToBottom()` smooth-scrolls and re-pins.
  Cleanup on unmount. Guard: observer must not thrash — one rAF per burst.
- Thread/parent: render the pill (`.jump-bottom-pill`, styles from UNIT-103)
  when `!pinned` AND the active session has a streaming turn (reuse the
  streaming flag threading from UNIT-102); onClick → jumpToBottom. New
  message arrival while pinned = auto-follow (that's the observer path).
- Tests (jsdom): pinned math at threshold; unpin on upward scroll; re-pin
  after jumpToBottom; MutationObserver growth while pinned scrolls container
  (mock scrollHeight); growth while unpinned does NOT scroll; cleanup
  disconnects.

## Constraints
- No polling/setInterval. No scroll-jacking when unpinned — never move the
  user's viewport except when pinned or explicitly jumping.

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; test count increased (report before/after)
- [ ] (assertional) unpinned viewport is never programmatically scrolled; pill only during active stream while unpinned; hook file self-contained (no store imports inside the hook itself)

## Dependencies
UNIT-102 (streaming flag threading exists)
