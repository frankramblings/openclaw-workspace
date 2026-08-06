# UNIT-402 — ⌘K palette UI

## Objective
Shell-level palette: hotkey + rail affordance, grouped results, keyboard nav,
navigation on Enter.

## Inputs / context
- CONTRACT.md interfaces (binding). Spec decision 2.
- Shell root: discover where global chrome mounts (src/shell/ — Dock.tsx,
  the rail, main.tsx) and mount the palette + keydown listener there.
- `src/kit/Modal.tsx` — reuse/extend for the overlay; kit styles.
- Chat store `selectSession`; other tabs' open/select actions — discover and
  document in navigate.ts's header. Tab switching: `src/tabs/registry.ts` +
  however the shell switches tabs today.
- Existing semantic search usage: chat store.ts:348 (`/api/search`) — the
  palette store calls BOTH /api/palette and /api/search on the debounced
  query and merges per the contract (dedupe chat hits by session id;
  title-matches first).

## Approach
- store.ts (zustand, module-scoped like other stores): open state, query,
  debounced (~200 ms) fetch pair (abort/ignore stale responses — keep a
  request generation counter), grouped results, selectedIndex across the
  flattened list, recents (empty-q response). Both fetches failing → honest
  inline error state; ONE failing → show the other + a subtle notice line.
- Palette.tsx: input autofocused, groups with headers, active row
  highlighted, mouse hover sets selection, Enter/click → `openResult` +
  close, Esc closes. Mobile: full-screen sheet styling ≤640 px.
- Hotkey: document keydown ⌘K/Ctrl-K toggles (preventDefault — must beat
  browser default); Esc closes only when open. While open, background app
  hotkeys must not fire (stopPropagation within the modal).
- Rail: a search button near the existing rail controls (discover; match
  chrome) → opens palette.
- navigate.ts: per contract; unknown kind → no-op + console.warn.
- Tests: store — debounce + stale-response discard (fake timers), merge/
  dedupe logic, one-source-degraded state; component — ⌘K opens, Esc
  closes, ↑↓ moves selection across group boundaries, Enter calls
  openResult with the selected result; navigate — each kind dispatches to
  the right store action (mock stores).

## Constraints
- No new deps; no portal library — kit/Modal's approach. Palette must not
  mount per-tab (shell-level once).

## Acceptance criteria
- [ ] (runnable) `cd frontend-next && npm run build && npm test` — no failures beyond the 3 known; counts reported and increased
- [ ] (assertional) stale responses can never overwrite newer results; ⌘K never types a 'k' into a focused input (preventDefault verified); selection navigation works across empty groups

## Dependencies
UNIT-401
