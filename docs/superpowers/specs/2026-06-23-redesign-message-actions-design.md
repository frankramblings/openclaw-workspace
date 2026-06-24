# Redesign: conversation-row menu + message hover toolbar

**Date:** 2026-06-23
**Status:** Approved design, ready for implementation plan
**Scope:** Frontend-only. Zero backend changes.

## Summary

Port two interaction patterns from the classic design (`frontend-overrides/index.html` +
`js/chat.js` + `js/sessions.js`, with footer logic in `frontend-vendor/js/chatRenderer.js`)
into the redesign SPA (`index-redesign.html` + `js/redesign/*`):

1. A **per-row context menu** on each conversation in the sidebar (kebab → 5 items).
2. A **per-message hover toolbar** with Copy + Download.

Both are built natively in the redesign's state→HTML re-render model with `data-act`
delegation, styled from the existing `redesign.css` token system.

## Why this scope (and what is deferred)

The classic message *context menus* (Edit, Regenerate from here, Rewrite shorter, Explain
simpler, Delete message on assistant; Edit/Delete/Resend on user) depend on backend
endpoints that **do not exist in this repo's backend** (`backend/app.py`):

| Classic action | Required endpoint | Present? |
| --- | --- | --- |
| Regenerate, Resend, Edit (user) | `POST /api/session/{id}/truncate` | No |
| Delete message | `POST /api/session/{id}/delete-messages` | No |
| Edit (assistant) | `POST /api/session/{id}/edit-message` | No |
| Rewrite shorter / Explain simpler | `POST /api/rewrite` | No |

The only catch-all is `GET /api/{path:path}` → returns `[]`; POSTs to those paths 404.
Those calls were inherited in `chat.js` from an upstream that implemented them; this
backend never did, and the transcript is owned by the gateway/brain, so adding them also
depends on whether the gateway supports transcript mutation (an unanswered question).

**Decision (user):** ship the frontend-feasible set now; defer all message-mutation
actions — and the rewrite variant-toggle UI — to a separate future backend project. The
message toolbar is structured so an overflow/kebab menu can slot those in later without
rework.

### What IS backed by existing endpoints (in scope)

- Conv-row menu items: Rename (`PATCH /api/session/{id}`), Favorite
  (`POST /api/session/{id}/important`), Copy Chat (client-side), Archive
  (`POST /api/session/{id}/archive`), Delete (`DELETE /api/session/{id}`).
- Message toolbar: Copy (clipboard), Download (client-side blob).

## Architecture context

The redesign renders HTML strings from a `state` object and re-renders on change. Menus
are state flags (e.g. existing `chat.chatMenuOpen`) gating conditional HTML. Events use
delegation: `app.js` resolves `e.target.closest('[data-act]')` and calls
`actions[name](dataArg, event)` — handlers receive a single string arg.

Relevant files:

- `js/redesign/surfaces.js` — `convListBody()` (sidebar rows), `chatMsg(m, s)` (one
  message), `chatSurface()` (header menu reference pattern at `.chat-more-menu`).
- `js/redesign/live/chat.js` — the `actions` object + `buildGroups()` (row shape) +
  `fetchThread()` (thread items). Existing handlers: `renameSession`, `copyTranscript`,
  `exportChat`, `archiveSession(id)`, `deleteSession(id)`, `selectSession(id)`.
- `js/redesign/app.js` — `data-act` delegation; outside-click menu close pattern.
- `js/redesign/icons.js` — icon set (`I.*`), source for copy/download/star/kebab glyphs.
- `redesign.css` — token system + existing component styles.

### Data dependencies

- **Row shape** (`buildGroups`, currently `{id, title, term, active}`): add
  `important: !!s.important` so the favorite star reflects server state. (`/api/sessions`
  records carry `important`; `set_important` writes it.)
- **Thread items** (`fetchThread` / live `send`): already carry a stable `id`
  (`h{i}` for history, `live-{ts}` for streamed). Toolbar handlers look up the message by
  `id` in `chat.thread`. No DB ids are needed because Copy/Download are client-side only.

## Component 1 — Conversation-row context menu

### Behavior
- Each `convRow` renders a `⋯` kebab trigger that **replaces** the two always-on inline
  icons (archive + ✕) currently shown at `opacity:.5`. The kebab fades in on row
  hover/active only.
- Clicking the kebab (`data-act="toggleConvMenu" data-arg="{id}"`) toggles
  `chat.rowMenuOpen` to that row's id (or null). The menu renders inline in the row when
  `rowMenuOpen === r.id`.
- The menu closes on: any item action, a second kebab click, or an outside click
  (extend the existing outside-click handler that already closes `chatMenuOpen`).
- Only one row menu open at a time.

### Items and wiring

| Item | Handler | Endpoint / behavior |
| --- | --- | --- |
| Rename | `renameSession(id)` — generalize existing (falls back to `chat.activeId` when arg empty, so the header menu keeps working) | `PATCH /api/session/{id}` with `name` |
| Favorite / Unfavorite | `toggleFavorite(id)` — **new** | `POST /api/session/{id}/important` with toggled bool; reload list; star reflects state |
| Copy Chat | `copyTranscript(id)` — generalize: active row uses `chat.thread`; other rows `GET /api/history/{id}` then build text | clipboard |
| Archive | `archiveSession(id)` — existing | `POST /api/session/{id}/archive` |
| Delete | `deleteSession(id)` — existing (confirm-guarded) | `DELETE /api/session/{id}` |

Label flips Favorite ⇄ Unfavorite based on the row's `important`. No favorites
re-ordering in this pass (rows keep date-group order); a filled star is the only signal.

### Out of scope (classic items intentionally dropped)
- **Move to folder** — no folders backend exists.
- **Select** (bulk mode) — no bulk-select infrastructure in the redesign.

## Component 2 — Message hover toolbar

### Behavior
- `chatMsg(m, s)` appends a `.msg-tools` row to both user and assistant messages.
- Hidden by default; revealed on message-row hover (and on keyboard focus within the
  message, for accessibility).
- Buttons: **Copy** and **Download**, each `data-arg="{m.id}"`.
- Left-aligned under assistant text; right-aligned under the user bubble (mirrors classic).

### Handlers (new, in `live/chat.js` actions)
- `copyMessage(id)` — find `chat.thread` item by `id`, `navigator.clipboard.writeText(m.text)`.
- `downloadMessage(id)` — find item, download `m.text` as a `.md` blob (reuse the
  `exportChat` blob/anchor pattern); filename from a slug of the first line.

Both no-op safely if the message or text is missing.

## Component 3 — Visual treatment (from `redesign.css` tokens)

Tokens in play: `--bg:#15161a`, `--panel:#1b1c21`, `--elev:#262931`, `--bd:#2d2f36`,
`--fg:#dfe2e8`, `--mut:#9498a2`, `--faint:#5f636d`, `--row-hover:#1d1f24`,
`--red:#f0726a`, `--gold:#e8c268`, `--sans` (IBM Plex Sans), `--mono` (JetBrains Mono).

### Menus (`.conv-menu`, reusing the `.slash-menu` / `.chat-more-menu` language)
- `background: var(--elev)`, `border: 1px solid var(--bd)`, `border-radius: 12px`,
  `box-shadow: 0 18px 50px rgba(0,0,0,.5)`, `padding: 6px`, positioned within the row.
- Items (`.cm-item`): `font: 13px var(--sans)`, `padding: 8px 10px`, `border-radius: 7px`,
  `color: var(--mut)` → hover `background: var(--row-hover)`, `color: var(--fg)`.
- **Delete** is the only colored item: `color: var(--red)` on hover. Danger earns the one
  red note; everything else stays monochrome.

### The single accent — favorite star
- `--gold` (already in the palette, currently barely used) is spent here and nowhere else.
- Favorited row: filled star in `--gold`. Unfavorited: hairline `--faint` outline.
- This is the one memorable spot of warmth; the rest of the new chrome is monochrome.

### Row kebab
- Replaces the two always-on icons. `⋯`, `color: var(--faint)` → `var(--mut)` on hover.
- Visible only on `.conv-row:hover`, `.conv-row.active`, or when this row's menu is open
  (so the default sidebar is quieter than today).

### Message toolbar (`.msg-tools`)
- Small icon buttons: ~26px hit area, transparent, `color: var(--faint)` → hover
  `color: var(--fg)` + `background: var(--row-hover)`, `border-radius: 7px`.
- Reveal: `opacity 0 → 1` + `translateY(2px → 0)` over 120ms on message hover/focus-within.
- `@media (prefers-reduced-motion: reduce)`: no transform/transition, opacity only.
- Tooltips via `title=`: "Copy message", "Download message".

### Constraints
- No new type families, no new palette entries, no border-radius drift from existing
  components. Consistency is the point.

## Accessibility / quality floor
- Kebab and toolbar buttons are real `<button>`s with `title`/`aria-label`.
- Toolbar reveals on `:focus-within` as well as `:hover` so keyboard users reach it.
- Visible focus outline retained; `prefers-reduced-motion` respected.
- Menu closes on Escape and outside click.

## Testing
- Existing redesign tests live in `js/__tests__/`. Add unit coverage where the logic is
  pure/DOM-light:
  - `buildGroups` includes `important` on rows.
  - `convListBody` renders the kebab and (when `rowMenuOpen` matches) the 5 menu items.
  - `chatMsg` renders `.msg-tools` with Copy/Download for both roles.
  - `toggleFavorite` / generalized `renameSession` / `copyTranscript` argument handling
    (active vs. specific id) — via the existing module test harness.
- Manual: rename, favorite/unfavorite (star toggles), copy chat (active + inactive row),
  archive, delete; copy/download a message; outside-click + Escape close the menu;
  keyboard reachability.

## Files touched
- `frontend-overrides/js/redesign/surfaces.js` — `convListBody` (kebab + inline menu),
  `chatMsg` (toolbar).
- `frontend-overrides/js/redesign/live/chat.js` — `buildGroups` (`important`); new
  `toggleConvMenu`, `toggleFavorite`, `copyMessage`, `downloadMessage`; generalize
  `renameSession` + `copyTranscript` to accept an id.
- `frontend-overrides/js/redesign/app.js` — outside-click close for `rowMenuOpen` (extend
  existing pattern).
- `frontend-overrides/redesign.css` — `.conv-menu`, `.cm-item` (if not already shared),
  kebab visibility, favorite star, `.msg-tools`.
- `frontend-overrides/js/__tests__/` — new tests per above.
