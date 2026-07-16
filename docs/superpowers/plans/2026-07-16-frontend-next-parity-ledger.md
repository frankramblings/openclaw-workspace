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
| Responsive desktop rail and mobile tab bar | P0 | done | 12-tab IA, safe-area bottom rail, overflow, persisted desktop collapse/resize, desktop/phone browser gate |
| Mobile navigation/sheet history | P0 | done | Shared modal/companion history stack; nested layers close in order; phone browser gate uses real Back |
| Global error/retry and pushed toasts | P0 | done | Remote stale-data retry plus centralized success/failure mutation notices and inline recovery state |
| Turn-completion notifications/unread state | P0 | building | Background sessions notify once and open the correct thread |
| Workspace explorer | P0 | done | Browse, preview/edit, CRUD, upload/download, drag/drop, roots, persisted width/open state, browser gate |
| Companion and persistent terminals | P0 | done | Per-session persistent-cwd PTYs, reconnect, multi-pin grid, resize, clear/kill and image drop; desktop/phone live gates |
| Live task feed | P1 | done | Snapshot + SSE, terminal state, stalled state and task detail |
| Installable/offline PWA lifecycle | P1 | done | Manifest/SW/update/install behavior matches `/` without stale-shell traps |
| Persisted layout/preferences | P1 | done | Rail/chat/companion dimensions and opened surfaces survive reload; geometry asserted in browser gate |

## Chat

| Workflow | Priority | Status | Acceptance |
| --- | --- | --- | --- |
| Send/stream/tools/thinking/stop | P0 | done | Typed full protocol reducer, server stop, reconnect error, real-turn browser gate |
| Reload and resume active turn | P0 | done | Durable event snapshot/tail reconciliation with cursor and stale-reader guards |
| Session create/select/rename/archive/favorite/model/speed | P0 | done | Complete actions with response refresh and visible per-session pending states |
| Title + semantic message search | P0 | done | Debounced `/api/search`, local title matches, deduplicated semantic sessions |
| Message copy/branch/download | P0 | done | Prefix-correct branch; clipboard and MD/PDF message/transcript export |
| Buffered send and inline edit grace period | P0 | done | 700ms pending bubble can edit/cancel/save without cross-session leakage |
| Cross-session queue | P0 | done | Per-session multi-send queues, recall/cancel, durable reload persistence |
| Conversation completion/unread indicators | P0 | done | Working/queued/completed states persist, clear on open, and notify once |
| Regenerate/continue and attachment replay | P1 | done | Server truncation at preceding user; original attachment IDs replayed; cutoff-aware continue |
| Slash commands and setup flows | P1 | done | Command menu, filtering/arguments, mouse and keyboard selection |
| Chat usage/context indicators | P1 | done | Values come from server usage routes and refresh after turns |
| Mobile composer, drawers, tools and gestures | P0 | done | Bottom composer, session/model drawers, visible message tools and real Back browser gate |
| Research mode and progress inside Chat | P1 | done | Deep-research send flag plus `/research` command; shared task/progress completion surfaces |

## Inbox, Email, Calendar and Notes

| Workflow | Priority | Status |
| --- | --- | --- |
| Inbox source filters, rich cards, detail, snooze, undo and gestures | P0 | done |
| Email account/folder/list/search/read caching and navigation | P0 | done |
| Email reply/reply-all/forward, attachments, move, deployment-scheduled state and RSVP | P0 | done |
| Calendar month/agenda navigation, CRUD, quick add and event detail | P1 | done |
| Calendar drag/resize and mobile agenda | P2 | missing |
| Notes cards, pin/archive/checklists/reminders/reorder | P1 | done |

## Documents and workspace content

| Workflow | Priority | Status |
| --- | --- | --- |
| Multi-document tabs, rename/reorder and session integration | P0 | done |
| Rich markdown editor, save/version/restore/export | P0 | done |
| Email-compose documents and recipient workflow | P0 | done |
| PDF capability truthfulness | P1 | done | Deployment route returns explicit 501 and render/export routes are legacy stubs; `/next` exposes that limitation without fake controls |
| Library search/filter/sort and deep selection | P1 | done |

## Research, operations and settings

| Workflow | Priority | Status |
| --- | --- | --- |
| Research start/progress/resume/cancel/report/library | P1 | done |
| Cron history/actions plus live jobs/logs | P1 | done |
| Memory full edit/audit/extract/import flows | P2 | done |
| Skills detail/toggle/audit/install/delete truthfulness | P2 | done |
| Settings status plus typed editable forms/test actions | P1 | done |

## Cutover gate

`/next` cannot replace `/` until all P0 rows are `done`, their browser workflows
pass at desktop and phone viewports, and normal work has run through `/next` for
one week with `/` retained as rollback.
