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
| Turn-completion notifications/unread state | P0 | done | Active-session polling, durable completion dots, one transition notification and click-through selection |
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
| Email reply/reply-all/forward, attachments, move, deployment-scheduled state and RSVP | P0 | done | Received attachments stream real MIME bytes; compose/draft uploads are embedded in outgoing MIME; missing uploads fail instead of silently sending |
| Calendar month/week/agenda navigation, CRUD, quick add, sync confirmation and event detail | P1 | done | Server-confirmed sync state is shown with the local receipt time because the provider route returns no timestamp |
| Calendar drag/resize and mobile agenda | P2 | done |
| Notes cards, pin/archive/checklists/reminders/reorder | P1 | done |

## Documents and workspace content

| Workflow | Priority | Status |
| --- | --- | --- |
| Multi-document tabs, rename/reorder and session integration | P0 | done |
| Rich markdown editor, save/version/restore/export | P0 | done |
| Email-compose documents and recipient/attachment workflow | P0 | done |
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

## Verification hole found after the campaign (2026-07-16, main@dbee40e)

The chat "real-turn browser gate" backing the P0 send/stream row was passing on
**dead selectors**: `.msg.assistant` and `.activity-trail` exist nowhere in the
React DOM (the components render `.msg-role` and `.act-step-head`), so the gate
had silently degraded to checking the Stop button alone.

Behind that hole was a real defect: sending immediately after `New chat`
silently re-homed the message to the *previous* conversation, because
`createSession` is async and the composer stayed bound to the outgoing session
until it settled. Reproduced 3/3 headless; the new chat showed "No messages yet"
while the text sat in another session's queue behind a 6px dot. Fixed by
blocking sends while a session creation is in flight; smoke selectors corrected.

Standing lesson for every row in this ledger: **a gate whose selector matches
nothing is worse than no gate** — it converts "untested" into "verified". When
adding a browser assertion, assert that the selector matches something before
trusting what it implies.

## Selector preflight added (2026-07-16, follow-up)

Auditing the smoke script against React source turned up a second instance of
the same defect the lesson above warned about: the `Skeleton` component
rendered `.next-skel` while `frontend-next/scripts/smoke.mjs` polled for
`.next-skeleton`. Four wait-fors keyed on `!document.querySelector('.next-skeleton')`
had been silently passing instantly — the per-tab "wait for loading to finish"
gate (all 12 tabs × 2 viewports = 24 checks), plus the inbox reader, cron
detail, and task panel "not still loading" assertions. Fixed by renaming the
component's class to `next-skeleton` (+`next-skeleton-line`).

To convert the standing lesson from prose to enforcement, `smoke.mjs` now runs
a **selector preflight** before the first gate: it extracts every `.next-*` /
`.msg-*` / `.act-*` / `.composer` / `.chat-thread` token used anywhere in the
script, fetches every stylesheet + script URL the app loaded, and requires
each token to appear as a bare word. Rename or typo → the run fails at the
preflight with the exact missing token(s), not several minutes later with a
silent pass or an opaque timeout. It does NOT catch structural drift like a
two-class selector where each class exists but never co-occurs; the gate
authoring rule still applies to those.
