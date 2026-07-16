# frontend-next Morning Report — 2026-07-16

## Outcome

`/next/` is built, mounted, and live on the workspace service. All twelve rail tabs are native React/TypeScript surfaces; none remain `StubTab`. The classic PWA at `/` is unchanged and remains available.

Service verification after the final restart:

- `openclaw-gateway.service`: active/running; `/api/gateway/status` state `ok`
- `openclaw-workspace.service`: active/running
- classic PWA `/`: HTTP 200
- new app `/next/`: HTTP 200
- current hashed JS asset: HTTP 200
- `/api/health`: `ok: true`, `gateway: ok`

## Native surface matrix

| Tab | Native in `/next` | Main capabilities |
| --- | --- | --- |
| Chat | Yes | sessions, history paging, models/speed, markdown/activity, attachments, suggestions, Stop, reload/resume reconciliation |
| Inbox | Yes | source-grouped feed, origin-time ages, actions, undo/history, triage, handoff, Slack/Asana detail |
| Email | Yes | folders/list/search/reader, urgency, sandboxed HTML, received and compose attachments, send/draft, reply/forward, RSVP, AI reply/summary, scheduled cancellation |
| Calendar | Yes | month/week/agenda views, event create/edit/delete, drag/resize, ICS import, quick parse, explicit sync confirmation |
| Notes | Yes | notes/todos/goals, checklists, pin/archive/reminders, response-backed autosave state, delete, up/down reorder |
| Documents | Yes | multi-document library/editor/markdown preview, versions/restore, archive/delete/export, email with attachments |
| Research | Yes | start/cancel, JSON-SSE progress, active-run resume, reports/PDF, archive/delete |
| Library | Yes | unified document/research browse, owning-tab deep links, workspace ZIP export |
| Cron | Yes | all scheduled jobs including disabled, enable/disable/run, run history, live jobs SSE/logs |
| Memory | Yes | filter/sort/add/edit/pin/delete/bulk delete, tidy, reviewed conversation extraction and file import/export |
| Skills | Yes | installed/builtin lists, create/edit, capability-aware delete, enable state, markdown detail and live audit-all progress |
| Settings | Yes | gateway/doctor, current connection state, default model, web-search settings, MCP reconnect, backup export |

## Contract findings

- Consumed read routes were checked against the running service and their real response containers; the browser smoke then exercised the stateful navigation paths rather than relying on route curls alone.
- The deployed chat replay endpoint is `/api/chat/stream?session=&last_event_id=`; it reuses the chat event reducer after hydrating `/api/chat/turn` snapshots.
- `/api/research/report/{id}` returns rendered HTML, not a markdown JSON body. `/next` therefore embeds it in a sandboxed iframe; live progress still uses typed JSON SSE.
- `/api/workspace/archive` is a ZIP download for a requested directory, not a browsable third collection. Library exposes the honest ZIP action beside browsable Documents and Research sections.
- Email urgency currently returns `per_uid`; chips render only when that response contains a value. Scheduled email is currently an array and is rendered only when non-empty.
- The old email attachment URL was an explicit `[]` legacy stub. It is now a real MIME download route, and compose/draft attachments reuse the upload registry and are embedded by the server. Invalid or missing upload tokens fail visibly.
- Himalaya can return JSON `null` for an empty search. The adapter now normalizes that response to `{emails:[], total:0}` instead of raising a 500.
- Email and calendar connection POST routes report `managed_externally`; Settings presents them read-first instead of pretending edits change those external config files.
- Skill deletion returns 501 and builtin skills may be empty. Unsupported controls are not rendered as working actions.
- Calendar sync returns `{ok:true}` without a server timestamp. The UI says “Sync confirmed by server” and does not invent a last-sync time.

## Deliberate deferrals

- Fonts remain coupled to absolute `/static/fonts/...` URLs from the classic app.
- Workspace-file markdown deep links are not a `/next` feature yet.
- Email style extraction/editing and reminders are not included in the contracted `/next` Email surface; RSVP is implemented.
- Notes reorder uses up/down controls instead of drag-and-drop.
- Account administration, contacts, voice/image labs and hardware/model-cookbook panels from the broad vendor bundle are outside the approved twelve-surface `/next` information architecture.
- No gallery is shown because the backend exposes none.

## Verification

- Frontend: 37 test files, 169 tests passed
- TypeScript: `npx tsc --noEmit` passed
- Production: `npm run build` passed
- Backend: 1,199 tests passed (9 existing dependency/runtime warnings)
- CDP smoke: all 12 hashes and the specialized workflows at 1440×900 and 390×844, zero console errors
- Chat smoke: temporary session, streamed `ping`, mid-stream capture, Stop when visible, session cleanup

Screenshots are in `/tmp/frontend-next-parity-final-2026-07-16/`:

- `desktop-<tab>.png` and `iphone-<tab>.png` for all 12 tabs
- `desktop-chat-mid-stream.png`
- specialized workflow captures for Email, Calendar, Notes, Documents, Research, Library, Cron, Memory, Skills, Settings, Tasks, Workspace and Terminal

## Suggested test drive

1. Open `/next/#/chat`; send a turn, reload mid-turn, and confirm the stream resumes.
2. Exercise an Inbox action and Undo.
3. Read an HTML email and confirm its content remains isolated; try summary or AI reply.
4. Quick-parse a calendar event, review it, then create it.
5. Edit a Note and Document and watch their save states.
6. Start Research, leave the tab, return through Active runs, and open the report.
7. Inspect disabled Cron entries and the live Jobs panel.
8. Finish in Settings and confirm Gateway and Doctor reflect live backend results.

## Cutover checklist

- [ ] Frank completes the test-drive path on desktop and phone.
- [ ] Chat reload/resume is exercised during a genuinely long tool run.
- [ ] One real mutation is verified in Inbox, Email, Calendar, Notes, and Documents.
- [ ] Mobile calendar density and long Library/Skills lists are acceptable in daily use.
- [ ] Decide whether to port the deliberate deferrals before making `/next` the default.
- [ ] Keep `/` as rollback until at least one normal workday completes without a blocker.
