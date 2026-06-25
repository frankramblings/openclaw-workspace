# Inbox Parity — Design

**Date:** 2026-06-25
**Goal:** Restore the classic Inbox's full triage capability inside the *current* redesign aesthetic. Keep the clean card look; pour the classic functionality back in.

## Headline finding

The backend already supports ~95% of the classic feature set. The redesign frontend stopped *calling* it and collapsed every per-source action into a single `dismiss`. This is a **frontend re-wiring job**, not a backend build.

Concrete regression: the redesign's "✦ Triage with Gary" button does **not** triage — it bulk-dismisses the FYI group. It never calls `/api/items/triage` or `/api/items/spinoff`.

## Architecture (redesign)

- **Render:** `surfaces.js → inboxSurface(s)` (desktop), `mobile/mobile-surfaces.js → mInbox(s)` (mobile). Cards are HTML strings with inline styles; CSS classes in `surfaces.js`/`mobile.css`.
- **Wiring:** `live/inbox.js` — `load(state)` maps `GET /api/items` into a card shape; `actions = { dismiss, triageAll }`.
- **Dispatch:** `app.js:308` delegates clicks on `[data-act][data-arg]` → `actions[name](arg)`.
- **State/render:** `live/runtime.js` — `runtime.state`, `runtime.render()`. Modules mutate state, call render.
- **Module registry:** `live/index.js` — `load()` + `actions` per surface; `reload(name)` force-refetches.

## Backend (already available)

| Capability | Endpoint | Status |
|---|---|---|
| Feed (all sources + counts + errors) | `GET /api/items` | ✅ |
| Per-source action (archive/delete/mark_read/complete/reviewed/dismiss/snooze) | `POST /api/items/action` (`source,id,action,until,title,meta`) | ✅ returns `undoTs` |
| Undo | `POST /api/items/undo` (`ts`) | ✅ remote undo for gmail/asana |
| History | `GET /api/items/history?limit=` | ✅ |
| AI triage scoring | `POST /api/items/triage` | ✅ |
| Hand-to-Gary | `POST /api/items/spinoff` (`item,intent`) | ✅ dedupes 24h |
| Email reader | `GET /api/email/read/{uid}` | ✅ |
| Slack thread reader | `GET /api/inbox/slack/thread?channel_id&thread_ts` | ✅ |
| Asana task reader | `GET /api/inbox/asana/task?gid` | ✅ |
| Sources | gmail, slack, asana, **obsidian, documents** | ✅ (redesign ignores last two) |

Backend item carries: `id, source, title, subtitle, snippet, ts, ageHours, score, actions[], rec{action,by,reason,confidence}, meta{}`. Deep-link `meta.url` present for slack/asana/obsidian/documents; gmail resolves via the email reader.

## Parity matrix (classic → redesign gap)

| # | Feature | Classic | Redesign now | Backend ready? | Plan |
|---|---|---|---|---|---|
| 1 | Per-source real actions | archive/delete/mark_read/complete/reviewed/reply | all → `dismiss` | ✅ | Restore real action set per source |
| 2 | Click-out to source | per-source `meta.url` + gmail msgid resolve | none | ✅ | "Open ↗" via `meta.url` / email-read |
| 3 | In-place reader | email/slack/asana/calendar invite | none | ✅ | Detail panel reusing email sanitizer |
| 4 | AI rec chip (tappable) | `✨ reason`, tap = do rec action | static `suggest` pill, not tappable | ✅ | Tappable rec chip → action or Gary |
| 5 | Real Triage | `POST /api/items/triage` + toast | bulk-dismiss FYI (broken) | ✅ | Wire real triage; rename/fix button |
| 6 | Hand-to-Gary | spinoff, intent | none | ✅ | 🤖 button → spinoff → open session |
| 7 | Snooze | presets + custom `until` | none | ✅ | Snooze menu (Later/Tomorrow/Next wk) |
| 8 | Undo + history | toast undo + ⏰ drawer | none | ✅ | Toast w/ undo; history drawer |
| 9 | Source filter chips | toggle active filter | rendered, inert | ✅ | Make chips filter the feed |
| 10 | Counts + error states | backend `sources`/`errors` | client-counts only | ✅ | Use backend counts; ⚠ error chips |
| 11 | Obsidian + Documents | full sources | not styled/filtered | ✅ | Add styles + chips + actions |
| 12 | Unread sidebar dot + seen | 120s poll, localStorage seen-set | none | ✅ (feed ids) | Dot poll + seen tracking |
| 13 | Mobile swipe | L/R, snooze+dismiss, flick, swipe-down dock | left-swipe-archive only | ✅ | Extend gesture set (scoped) |
| 14 | Toasts | 8s + undo | none | n/a | Toast component |

## Approach

**Re-wire, don't revert.** Keep `inboxSurface`/`mInbox` card markup + aesthetic. Extend:
- `live/inbox.js` — richer `toMockItem` (carry `actions`, `rec{reason,confidence}`, `meta`, all sources), add actions: `act(id,action)`, `snooze`, `undo`, `triage` (real), `gary`, `openSource`, `openReader`, `setFilter`, `toggleHistory`.
- `surfaces.js` / `mobile-surfaces.js` — add per-card action row (real labels), rec chip, Open ↗, 🤖, snooze; detail/reader panel; history drawer; toast host; interactive filter chips + error/counts.
- New small modules where it keeps files tractable: `live/inbox-reader.js` (detail fetch + sanitize), `live/inbox-toast.js`.
- Reuse the existing email tab sanitizer (`/static/js/emailLibrary/utils.js`) for email bodies.

**TDD:** Pure logic (action mapping, snooze-time math, rec-label selection, swipe math, filter/group derivation, seen-set diff) gets node-asserted unit tests like the classic `scripts/test-swipe-math.mjs`. DOM render verified via the running app (systemd `openclaw-workspace.service`).

## Non-goals (this pass)

- No backend feature work beyond bug-level fixes (it's ready).
- Not reverting the visual redesign.
- Settings UI for inbox sources (config-driven today) — out of scope.

## Open decisions for Frank

1. **Sequencing** — recommend shipping in 3 reviewable slices: **(A)** real per-source actions + click-out + counts/errors/filters, **(B)** in-place reader + rec chip + Hand-to-Gary + real Triage, **(C)** snooze + undo/history + unread dot + mobile gestures. Each slice independently useful.
2. **Mobile swipe depth** — full classic engine (L/R + snooze + swipe-down dock) is the biggest single chunk. Recommend: extend current archive-swipe to L=dismiss / R=primary first, defer the swipe-down-to-dock chip unless wanted.
