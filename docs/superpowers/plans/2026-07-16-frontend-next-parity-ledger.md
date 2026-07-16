# frontend-next Workflow Parity Ledger

Updated: 2026-07-16. The current app at `/` is the behavioral oracle. A row is
`done` only when desktop, mobile, failure states, persistence, and a browser
workflow test match—not merely when an endpoint is wired.

## Status key

- `missing`: no usable equivalent
- `thin`: partial route/UI coverage, not daily-use equivalent
- `building`: current parity campaign work
- `done`: characterized and verified against the current app

## Shared shell and PWA

| Workflow | Priority | Status | Acceptance |
| --- | --- | --- | --- |
| Responsive desktop rail and mobile tab bar | P0 | building | Correct information architecture, safe areas, rotation, overflow and back behavior |
| Mobile navigation/sheet history | P0 | missing | Browser Back closes transient layers in current-app order |
| Global error/retry and pushed toasts | P0 | thin | Every failed load/mutation is recoverable without losing stale data |
| Turn-completion notifications/unread state | P0 | building | Background sessions notify once and open the correct thread |
| Workspace explorer | P0 | building | Browse, preview, edit, create, rename, move, delete, upload/download, drag/drop |
| Companion and persistent terminals | P0 | building | Attach/reconnect, multiple terminals, cwd, pins, resize, image drop |
| Live task feed | P1 | missing | Snapshot + SSE, terminal state, stalled state and task detail |
| Installable/offline PWA lifecycle | P1 | missing | Manifest/SW/update/install behavior matches `/` without stale-shell traps |
| Persisted layout/preferences | P1 | missing | Rail/pane widths and opened surfaces survive reload |

## Chat

| Workflow | Priority | Status | Acceptance |
| --- | --- | --- | --- |
| Send/stream/tools/thinking/stop | P0 | thin | Protocol-complete rendering, interruption and retry match current app |
| Reload and resume active turn | P0 | thin | Reload during long tool call never loses or duplicates output |
| Session create/select/rename/archive/favorite/model/speed | P0 | thin | All current conversation actions and truthful pending states |
| Title + semantic message search | P0 | building | Debounced `/api/search`, local title matches, no duplicate sessions |
| Message copy/branch/download | P0 | building | Prefix-correct branch; clipboard and MD/PDF export |
| Buffered send and inline edit grace period | P0 | building | 700ms pending bubble can edit/cancel/save without cross-session leakage |
| Cross-session queue | P0 | building | Sends queued per busy session, visible in composer and conversation row |
| Conversation completion/unread indicators | P0 | building | Working/queued/completed states survive navigation and reload |
| Regenerate/continue and attachment replay | P1 | missing | Replays original attachments and replaces correct assistant tail |
| Slash commands and setup flows | P1 | missing | Command menu, argument handling, keyboard selection, setup state |
| Chat usage/context indicators | P1 | done | Values come from server usage routes and refresh after turns |
| Mobile composer, drawers, tools and gestures | P0 | building | Current thumb-first flows, long press, sheets and edit behavior |
| Research mode and progress inside Chat | P1 | missing | Current research toggle/progress/completion behavior |

## Inbox, Email, Calendar and Notes

| Workflow | Priority | Status |
| --- | --- | --- |
| Inbox source filters, rich cards, detail, snooze, undo and gestures | P0 | thin |
| Email account/folder/list/search/read caching and navigation | P0 | building |
| Email reply/reply-all/forward, attachments, move, schedule and RSVP | P0 | building |
| Calendar month/agenda navigation, CRUD, quick add and event detail | P1 | thin |
| Calendar drag/resize and mobile agenda | P2 | missing |
| Notes cards, pin/archive/checklists/reminders/reorder | P1 | building |

## Documents and workspace content

| Workflow | Priority | Status |
| --- | --- | --- |
| Multi-document tabs, rename/reorder and session integration | P0 | building |
| Rich markdown editor, save/version/restore/export | P0 | building |
| Email-compose documents and recipient/attachment workflow | P0 | building |
| PDF import, form fields, annotations, AI fill and preview | P1 | missing |
| Library search/filter/sort and deep selection | P1 | building |

## Research, operations and settings

| Workflow | Priority | Status |
| --- | --- | --- |
| Research start/progress/resume/cancel/report/library | P1 | thin |
| Cron history/actions plus live jobs/logs | P1 | thin |
| Memory full edit/audit/extract/import flows | P2 | thin |
| Skills detail/toggle/audit/install/delete truthfulness | P2 | thin |
| Settings status plus typed editable forms/test actions | P1 | thin |

## Cutover gate

`/next` cannot replace `/` until all P0 rows are `done`, their browser workflows
pass at desktop and phone viewports, and normal work has run through `/next` for
one week with `/` retained as rollback.
