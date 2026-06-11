# Hermes Panel Mode — Design

**Date:** 2026-06-10
**Status:** Pending user review
**Builds on:** `2026-06-10-hermes-ui-adoption-design.md` (shipped). User approved
"panel-feel on the modal chassis" and asked for per-tab desktop/mobile layout
optimization — a list tool like Inbox must not stretch absurdly at full width.

## Goal

Strip-launched tools behave like Hermes panels — open maximized into the main
pane, one at a time, with active-tab state on the strip — WITHOUT rewriting any
tool: modalManager, drag/snap/dock/tile, and every tool's internals stay.

## Non-goals

- No per-panel sidebar-body swap (Hermes does this; deferred — keeping the
  conversation list always visible is arguably better here).
- No tool rewrites; no modalManager changes.
- No mobile presentation change: <768px the app already renders modals as
  bottom sheets anchored to the dynamic viewport (style.css ~6076) — that IS
  the optimized mobile UX. Panel geometry classes no-op under 768px.
- Popups stay popups (see whitelist).

## Mechanism (one overlay: `frontend-overrides/js/hermes-panels.js`)

1. **Classification table** `PANEL_SPECS: { windowId → {mode, width?} }` (below).
   Everything not in the table keeps today's floating behavior (popup whitelist
   by omission).
2. **Open detection:** MutationObserver watching the known window elements
   (class/style changes + body childList for dynamically-created ones like
   `#calendar-modal`, `#cron-modal`). "Visible" = computed display/visibility,
   same test the Chat button uses.
3. On a classified window becoming visible:
   - **Exclusivity:** close every OTHER classified window (factor the Chat
     button's close-sweep out of hermes-footer.js into hermes-panels.js; expose
     as `window.hermesPanels.closeAll(exceptId?)`; chat-home button calls it).
   - **Geometry:** add `hermes-panel` (and `hermes-panel-column` for column
     mode, with `--hermes-panel-w` set per spec). Desktop ≥768px only.
   - **Active tab:** `.hermes-active` on the matching strip button (mapping
     windowId → rail button id in the same table); chat-home gets
     `.hermes-active` when no classified window is visible.
4. **Geometry CSS (hermes.css):**
   - `.hermes-panel` (≥768px): fixed, `top:0; bottom:0; right:0;
     left: var(--sidebar-w, 0px)` (strip mode keeps `--icon-rail-w` at 0), no
     border-radius, no drag offset — and it must NEUTRALIZE dock/tile classes
     while present (`modal-left-docked`, snap transforms): the panel class wins.
     Where a tool has its own fullscreen pathway (email's
     `email-lib-fullscreen`, style.css:14647), PREFER triggering that tool's
     own mode over generic geometry — implementer verifies per tool.
   - `.hermes-panel-column`: panel backdrop = `var(--bg)`; the tool's content
     element is centered with `max-width: var(--hermes-panel-w)`, full height,
     `var(--panel)` surface + 1px side borders. The content element to target
     differs per tool (`.modal-content`, panel root, `.cron-modal-card`) — the
     table records it.
   - Window chrome in panel mode: keep ✕ and minimize (chips don't obscure
     chat and remain the power-user path); hide/disable drag handles and
     resize affordances via CSS.
5. **Escape hatch:** `localStorage['hermes-floating-windows'] = '1'` → overlay
   inert (body class `hermes-floating`, all panel CSS scoped to
   `body:not(.hermes-floating)`). Today's behavior back wholesale. Documented
   in the file header; optional Settings toggle deferred.

## Per-tab treatment (the UX heart of this spec)

Desktop (≥768px). Mobile is bottom-sheet for all, unchanged.

| Strip tab | Window (content el) | Mode | Width | Rationale |
|---|---|---|---|---|
| **Chat** | base layer | — | — | Active when no panel; click = closeAll. |
| **Email** | `#email-lib-modal` (`.modal-content`) | full-bleed | — | 3-pane mail client (folders/list/reader) genuinely uses width. Use its native `email-lib-fullscreen` mode. |
| **Inbox** | `#inbox-panel` (panel root) | column | 720px | THE stretch case: single triage list; cards at full width = unreadable horizontal sprawl. 720px keeps scan lines short, swipe affordances intact. |
| **Calendar** | `#calendar-modal` (`.modal-content`) | full-bleed | — | Month grid + agenda benefit from every pixel. |
| **Documents** | `doc-panel` (panel root) | full-bleed | — | Editor + library grid; prose width is governed inside the editor already. Library (rail-archive) is a view of the same panel. |
| **Deep Research** | `#research-modal` (verify id at impl) | column | 860px | Chat-thread-like; reading column. |
| **Notes** | `notes-panel` (panel root) | column | 960px | List + editor two-pane still comfortable at 960; full-bleed makes note lines book-width. |
| **Brain/Memory** | `#memory-modal` (`.modal-content`) | column | 960px | Card grid: cap prevents 5-across sprawl; 960 ≈ 3 columns. |
| **Cron/Tasks** | `#cron-modal` (`.cron-modal-card`) ⚠ custom overlay, NOT `.modal` | column | 800px | Job rows + run history = list tool, same logic as Inbox. Close via its own close control. |
| **Theme** | theme modal | **floating** | — | Picker popup; paneling it is hostile (you want to see the app behind it). |
| *(whitelist floating by omission)* | settings, confirm dialogs, model-endpoints, presets/characters, compare/cookbook/gallery (hidden chrome anyway) | floating | — | Dialogs, not destinations. |

Width values are starting points; implementer eyeballs each at 1440px and
adjusts ±15% where a tool's internal layout (e.g. notes' two-pane split)
clearly wants it — record final values in the code table.

## Acceptance

- Desktop: each of the 8 panel tabs opens maximized with the specified
  treatment; Inbox/Cron/Notes/Memory/Research render as centered columns on a
  `--bg` backdrop (no stretched lists); Calendar/Email/Documents full-bleed.
- Opening tab B closes tab A (exclusivity); strip shows exactly one
  `.hermes-active` (chat-home when none); Chat tab clears everything.
- Minimize-to-chip still works from panel mode; restoring a chip re-enters
  panel mode (re-classified on visibility).
- Mobile: bottom sheets pixel-identical to today; exclusivity + active state
  still function; no geometry classes applied.
- `hermes-floating-windows=1` restores today's floating behavior entirely.
- Theme picker and settings still float in both modes.
- No regressions: drag/snap/dock still work in floating mode; chat streaming,
  stop button, image send unaffected (no chat.js changes).

## Risks

| Risk | Mitigation |
|---|---|
| Dock/tile classes fight panel geometry | Panel CSS explicitly neutralizes docked/snap transforms while `hermes-panel` present; floating mode untouched |
| Per-tool content-element variance | Table records the element per tool; implementer verifies each before styling |
| Email's native fullscreen vs generic class double-applying | Prefer native mode for email; generic class only for tools without one |
| `#cron-modal` custom overlay | Explicit branch (already not `.modal`); its own close control |
| Restore-from-chip races the observer | Visibility observer is state-based (not event-based) — re-applies on any transition to visible |
| Research modal id unverified | Implementer locates the real container first; if research proves to be embedded rather than windowed, drop it from PANEL_SPECS and note it |

## Rollout

Single phase + polish pass; one overlay JS + hermes.css block + small
hermes-footer.js refactor (sweep moves out). All frontend — live on sync, no
backend restart. Spec → plan → subagent-driven, as before.
