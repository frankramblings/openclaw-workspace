# Inbox Swipe Triage — iOS-style gestures (mobile)

**Date:** 2026-06-07
**Status:** Approved design, pending implementation plan
**Builds on:** `2026-06-06-inbox-recommendations-design.md` (v2.1 — undo system,
✨ rec chips), `2026-06-05-native-inbox-design.md` (the Inbox tab itself)

## Goal

Make mobile triage fast: iOS-Mail-faithful swipe gestures on Inbox cards with
native-feeling tracking (1:1 finger follow, rubber-banding, velocity/flick
commits, spring snap-back). User decisions from brainstorming:

- **iOS Mail faithful** semantics (rejected: simple right=clear/left=snooze;
  rejected: right=clear/left=dismiss).
- **Right zone = ✨ rec action when present**, else the static per-source
  primary (rejected: always-static).
- Swipe commits are one-shot with no confirm — the v2.1 undo system is the
  safety net.

## Constraints

- Mobile only: gate on `matchMedia('(pointer: coarse)')`. Desktop is
  unchanged (buttons/chips remain the only affordance there).
- All code lives in `frontend-overrides/js/inbox.js` as a marked section + CSS
  in `frontend-overrides/workspace.css`. NO new script file (a new file needs
  a script tag in `frontend-overrides/index.html`; forgetting broke the tab
  once — see 2026-06-05 incident note).
- No libraries, no build step. Pointer Events API (supported by iOS Safari
  13+; this PWA already requires newer).
- Web has no haptics on iOS — the "commit armed" cue is visual (zone
  full-bleed snap + scale pulse).
- `prefers-reduced-motion: reduce` → all gesture transitions 0ms.
- No JS test runner exists in this repo; see Testing.

## 1. Gesture engine

Pointer Events on each `.inbox-item` (bound in `bindCard`, only when the
coarse-pointer media query matches):

- `pointerdown`: record start x/y + time; no capture yet.
- `pointermove` (pre-lock): until the pointer has moved 10px from start, do
  nothing. At 10px, LOCK direction: `|dx| > |dy|` → horizontal (call
  `setPointerCapture`, begin drag); else → vertical (mark the gesture dead;
  native scroll continues — `touch-action: pan-y` on `.inbox-item` means the
  browser never stalls the scroller waiting for us).
- During drag: `transform: translate3d(x, 0, 0)` on the card's content
  wrapper with NO transition (1:1 tracking). Past the maximum reveal width,
  apply rubber-band resistance: `x = max + (rawX - max) * 0.5`.
- Velocity: keep the last 5 `{x, t}` samples; on release, velocity =
  Δx/Δt over those samples (px/ms).
- `pointerup`: decide outcome (§3), then animate with
  `transition: transform 280ms cubic-bezier(0.25, 1, 0.5, 1)` to the snap
  target (zone-revealed offset, off-screen commit, or 0).
- `pointercancel` / a second concurrent pointer: spring to 0, gesture dead.
- Tap passthrough: if the pointer never reached the 10px lock, buttons/chips
  inside the card receive the click normally (no preventDefault before lock).

Feel-tuning constants grouped at the top of the section for iteration:

```javascript
const SWIPE = {
  LOCK_PX: 10,          // movement before direction lock
  ZONE_W: 88,           // px per revealed action zone
  COMMIT_RATIO: 0.6,    // fraction of card width = full-swipe commit
  FLICK_VMIN: 0.6,      // px/ms — flick commits regardless of distance
  RUBBER: 0.5,          // resistance factor past max reveal
  SNAP_MS: 280,
  SNAP_EASE: 'cubic-bezier(0.25, 1, 0.5, 1)',
};
```

## 2. Zones

Card DOM gains an absolutely-positioned under-layer per side (built in
`cardHtml`, hidden at rest, mobile-only via CSS):

- **Right swipe reveals the LEFT under-layer — one zone:** the ✨ rec action
  when `item.rec` exists and its action is directly executable or a spinoff
  (`archive|delete|mark_read|complete|reviewed|reply|gary`) — purple tint,
  `✨ <label>`; otherwise the static primary (`PRIMARY[source]`) — blue tint.
- **Left swipe reveals the RIGHT under-layer — two zones:**
  `Snooze (amber) | Dismiss (red)`, Dismiss outermost. Short-reveal state
  makes both tappable buttons; the Snooze button opens the existing
  3-preset snooze menu; Dismiss fires immediately.
- Past the commit threshold (§3) the about-to-commit zone snaps to
  full-bleed (background expands behind the whole card, label rides the
  moving card edge, ~120ms scale pulse on the label) — the iOS "armed" cue.
  Crossing back under the threshold reverses it.
- One card revealed at a time: locking a drag on any card, or a scroll
  event on the modal body, springs any other revealed card to rest.

Labels reuse `REC_LABELS`; zone colors come from CSS classes
(`swipe-zone-rec`, `swipe-zone-primary`, `swipe-zone-snooze`,
`swipe-zone-dismiss`) so themes can restyle them.

## 3. Commit semantics

On release with direction = horizontal:

| state | outcome |
|---|---|
| `|x| ≥ width * COMMIT_RATIO` OR `|v| ≥ FLICK_VMIN` (same sign as x) | COMMIT |
| else if `|x| ≥ ZONE_W * 0.5` | snap to revealed state (zones tappable) |
| else | spring to 0 |

- COMMIT right = the right-zone action: executable actions go through
  `doAction` (with the swiped card element so the existing optimistic
  removal + toast work); `reply`/`gary` go through `handToGary(it, zoneEl,
  action)` — for those, the card springs back to 0 while the spinoff runs
  (the page navigates on success).
- COMMIT left = **Dismiss** (outermost zone), through `doAction`.
- Commit animation for executable actions: card translates fully off-screen
  (same easing), then height-collapses 200ms, then the existing removal path
  runs. The undo toast appears as usual.
- While a card has an in-flight action (`dataset.pending`, same guard
  pattern as the chip), its gestures are inert.

## 4. Interplay & robustness

- History drawer rows: no gestures (feed view only).
- The revealed state adds a one-time `pointerdown` listener on the modal
  body that closes the reveal if the touch lands outside the revealed card.
- Snooze preset menu opened from a zone reuses `snoozeMenu` (anchored to the
  card as today); choosing a preset springs the card shut as part of
  `doAction`'s success path.
- `prefers-reduced-motion: reduce` (CSS media query + JS check): SNAP_MS
  effectively 0 — instant state changes, no springs, no pulse.
- Re-renders (`render()` rebuilds innerHTML): rebuilt cards start at rest;
  any in-progress gesture state dies with the old nodes (listeners GC with
  them — same lifecycle as the existing per-card bindings).

## 5. Testing

- The commit-decision math (`decideOutcome(x, v, width)` → `'commit' |
  'reveal' | 'rest'`, rubber-band transform, velocity-from-samples) is
  factored as pure functions on the IIFE's internal `SWIPE` helper and
  exercised by a `node` assert script in the plan (no test runner exists for
  frontend code; the script runs the pure functions in isolation by
  extracting them — they take numbers, return strings/numbers, no DOM).
- `node --check` + mirror-diff + headless-Chrome DOM render (zones present in
  rendered cards) as in prior tasks.
- **The real gate is manual:** the user flicks live cards on their iPhone
  (via the tailnet PWA) and judges the feel; the SWIPE constants exist to be
  tuned in that loop without touching logic.

## Out of scope (YAGNI)

- Swipes in the history drawer; swipe-to-undo.
- Haptics (impossible on iOS web), sound.
- Desktop drag-with-mouse gestures.
- Per-zone customization UI; long-press menus.
- Library adoption (Hammer.js etc. — rejected in brainstorming).

## Status

Implemented 2026-06-07 (plan
`docs/superpowers/plans/2026-06-07-inbox-swipe-gestures.md`); pure gesture
math node-asserted (scripts/test-swipe-math.mjs); verified by the user on
iPhone via the tailnet PWA ("looks good" — no tuning round needed). Review
fixes along the way: mobile snooze menu restyled as an in-card strip (the
swipe overflow mask clipped the dropdown), stale tap-suppress flag cleared on
pointerdown (iOS fires no synthetic click after long drags), failure ⚠
targets the zone label instead of clobbering the zone div.
