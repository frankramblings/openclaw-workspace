# Email Tab Triage Redesign — Design

**Date:** 2026-06-15
**Status:** Approved (design); pending implementation plan
**Surface:** Workspace Email tab (`frontend/js/emailInbox.js` + `frontend/js/emailLibrary.js`)

## Problem

The dedicated Email tab is clunky for day-to-day triage. Three concrete pains
(confirmed with the user):

1. **Bulk actions are buried.** Multi-select + bulk archive/delete only exist in
   a separate "Library" modal (`emailLibrary.js`), not in the main list the user
   actually lives in. Selecting many and acting at once means leaving the main
   surface.
2. **Opening a message is heavy.** Clicking a row opens the message as a full
   "document" in the doc pane — too slow for skim-and-decide triage.
3. **Per-message actions are slow.** Archive/delete/mark-read take too many
   clicks per row; there is no fast quick-action affordance on the row itself.

Keyboard-first power triage was explicitly **not** a priority — the redesign is
tap/click-first (arrow-key list nav is a cheap bonus, not the model).

## Goal

One Email tab that does triage + reading + bulk in place, retiring the separate
Library surface. Fast read-and-decide, inline bulk, one-tap row actions — on
both desktop and mobile.

## Non-Goals

- No keyboard-driven triage layer (j/k/e/#, command palette, etc.).
- No new email backend features beyond what already exists (see below). A
  server-side bulk endpoint is an explicit *later* optimization, not part of
  this work.
- The full threaded doc-pane reader is **not** removed — it stays reachable for
  deep reading and reply composition.
- No snooze for email (not requested). Archive/Delete/Mark-read·unread/Move/
  Hand-to-agent are the verbs.

## Approach (chosen)

**Redesign the Email tab in place and fold the Library into it.** The
"buried bulk" pain *is* the main-list-vs-Library split, so the fix is to merge,
not to add a third surface.

### Architecture & durability

- Promote `emailInbox.js` and `emailLibrary.js` into `frontend-overrides/js/`
  (the durable layer that `scripts/sync-frontend.sh` mirrors over the
  `frontend/` build output). All edits land in the overrides; the `frontend/js/`
  copies become regenerated build artifacts. This is also what makes the change
  survive upstream/base re-syncs.
- The Library modal's machinery (checkbox column, select-all, bulk bar, bulk
  delete/actions) **moves into the main list**. The Library entry point (button +
  any `openEmailLibrary` deep-link/hash) is **removed** and routed to the main
  Email tab instead — there is no second email surface after this.
- Reuse, do not reinvent: the existing HTML sanitizer
  (`emailLibrary/utils.js._sanitizeHtml`), folder sort/display logic
  (`sortedFolders`, `folderDisplayName`), compose/reply flow, the urgency/unread
  machinery, and the unified Inbox's `/api/items/spinoff` for Hand-to-agent.
- No new frontend dependencies.

## Layout & reading model (responsive)

A single `matchMedia` width check (~900px breakpoint) selects the mode; the same
code path serves both.

### Desktop (≥ ~900px) — two-column split

- Left: the message list. Right: a **reading pane**.
- Selecting a row renders the sanitized body in the pane plus an action toolbar:
  `Archive · Delete · Mark unread · Move ▾ · Hand to agent · Open full · Reply`.
- `↑`/`↓` move the selection (cheap nav; not a full keyboard layer). The list
  does not navigate away; reading stays in the tab.
- "Open full" escalates to the existing doc-pane reader for long threads / reply
  composition.

### Mobile / narrow (< ~900px) — list + quick-look

- Single list. Tapping a row opens a **full-screen quick-look overlay**
  (lightweight — *not* the doc pane) with the same action toolbar.
- Swipe left/right = prev/next message; swipe-down closes (matches the existing
  sheet-dismiss feel elsewhere in the app).
- The existing per-row swipe-left-to-archive gesture is preserved.

## Triage interactions

### Multi-select + bulk bar

- A checkbox appears on **row hover** (desktop) or **long-press** (mobile).
- First selection slides in a **bulk action bar** pinned at the top of the list:
  `[N selected] Archive · Delete · Mark read/unread · Move ▾ · Hand to agent · ✕`.
- Select-all lives in the bulk bar. `Esc` / `✕` clears the selection.

### Per-row quick actions

- On hover (desktop) or as the revealed swipe zone (mobile), each row exposes
  one-tap **Archive** + **Delete**. These mirror the bulk verbs so muscle memory
  transfers between single and bulk.

### Optimistic UI + undo

- Any action — single or bulk — removes the affected rows immediately and shows
  **one combined undo toast** (e.g. "Archived 4 — Undo"), reusing the existing
  toast/undo pattern.
- Undo restores all affected messages (re-fetch / re-insert).

### Move ▾ and Hand-to-agent

- **Move ▾** opens the folder list (reused from the existing folder selector);
  picking a folder moves the selected message(s).
- **Hand to agent** posts the email payload to the unified Inbox's
  `/api/items/spinoff`. Bulk hand-off seeds **one** session with the selected
  set, then navigates to it (same hash+reload pattern `inbox.js` uses).

## Data flow & actions

- All actions call the **existing per-uid endpoints** — confirmed present in
  `backend/email_himalaya.py`:
  - `POST /api/email/archive/{uid}`
  - `DELETE /api/email/delete/{uid}`
  - `POST /api/email/mark-read/{uid}` · `POST /api/email/mark-unread/{uid}`
  - `POST /api/email/move/{uid}?dest=<folder>`
  - `GET  /api/email/list?folder=&limit=&offset=&filter=` (list/paging unchanged)
  - `GET  /api/email/read/{uid}?mark_seen=` (reading-pane body)
- **Bulk = client-side fan-out** over the per-uid endpoints with a small
  concurrency cap (≈5 in-flight) and an aggregated result. No new backend for
  the core path. (A server-side bulk endpoint is noted as a future optimization
  only.)
- **Hand-to-agent** reuses `POST /api/items/spinoff` (inbox router).
- Selection state and reading-pane selection are module-level state, reusing the
  existing `state._selectedUids` set rather than introducing a parallel store.

## Error handling & edge cases

- **HTML safety:** the reading pane / quick-look render mail through
  `_sanitizeHtml`, with the **sandboxed-iframe fallback** already used in
  `inbox.js` (`<iframe sandbox srcdoc>`) when the sanitizer is unavailable —
  unsanitized mail HTML is never injected into the app document.
- **Empty folder:** "Inbox zero 🎉". **List/network error:** inline error +
  existing setup hint.
- **Partial bulk failure:** a failed item stays in the list with a `⚠` and a
  per-row retry; successful items proceed. Partial success is surfaced in the
  toast (e.g. "Archived 3, 1 failed"), never silently swallowed.
- **Mid-bulk navigation / folder switch:** in-flight actions complete; the undo
  toast still applies to the items that were acted on.
- **Long threads / huge HTML:** reading pane caps height and scrolls;
  "Open full" escalates to the doc reader.
- **Reduced motion:** pane/overlay transitions respect the existing
  `REDUCED_MOTION` (`prefers-reduced-motion`) check.

## Testing

- **Pure-logic node tests** (pattern: `scripts/test-swipe-math.mjs`), extracted
  as side-effect-free functions:
  - responsive breakpoint selection (width → desktop|mobile mode),
  - bulk-selection set math (toggle, select-all, clear, count),
  - prev/next index navigation including wrap behavior at list ends,
  - fan-out concurrency + partial-result aggregation (N items, K failures →
    correct success/failure tallies).
- **Backend:** existing `pytest` suite covers the per-uid endpoints. Add a test
  asserting `/api/items/spinoff` accepts an email payload (single and a bulk
  set) if not already covered.
- **Manual smoke (house rule — no headless Chrome on this host):** `node --check`
  on the override JS, `curl` the relevant endpoints for byte-level sanity, then
  user eyeballs live behavior on the `:8443` origin after a `sync-frontend` +
  workspace restart.

## Rollout / risk notes

- This touches a **live, heavily-used** surface on a fragile host (2014 Mac mini,
  swaps hard; cold restarts take 4–5 min). Implementation should be incremental
  and land behind the durable-override path so the live `frontend/` build is only
  changed at an explicit user-gated sync + restart.
- Suggested implementation slices (for the plan): (1) overrides scaffolding +
  retire Library split; (2) reading-pane / quick-look reading model; (3) inline
  multi-select + bulk bar + fan-out + combined undo; (4) per-row quick actions +
  Move + Hand-to-agent.

## Decisions made (not asked)

- **Bulk via client fan-out**, not a new backend bulk endpoint (sufficient at
  triage volume; reuses tested per-uid endpoints).
- **Full doc reader kept reachable** ("Open full") rather than deleted — the
  reading pane is the fast path, not a replacement for deep reading/replying.
