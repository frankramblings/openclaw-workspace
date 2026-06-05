# Native unified Inbox — 2026-06-05

Replace the triage-dashboard proxy with native collectors and give the unified
feed its first real UI.

## Why

`backend/inbox.py` proxies `/api/items` to the triage-dashboard (`:3456`) — a
pre-alpha app the user has abandoned. It is currently a zombie: the node
process listens but its event loop wedges seconds after boot (even `/health`
hangs; restart doesn't help; 0% CPU — blocked, not spinning). The proxy
degrades to `{items: [], error}`, and no frontend consumer ever landed ("v2
follow-up" in the v1 README). Decision (user, 2026-06-05): rebuild the feed
natively in the workspace — collectors AND a UI — then decommission the
dashboard.

## What exists to build on

- **Gmail**: `backend/himalaya_cli.py` + `email_himalaya.py` already list, read,
  archive and mark-read the real mailbox. Reuse outright.
- **Slack**: `ai.openclaw.slack-refresh` (launchd, independent of the dashboard)
  keeps `~/.openclaw/workspace/tmp/slack_recent_signals.json` fresh (verified
  today). Keychain holds `openclaw.slack.xoxc`/`.xoxd` (account `frank`) for
  mark-read; the workspace is a LaunchAgent in the GUI session, so it has
  keychain access — the same trick the dashboard used.
- **Asana**: PAT in `~/.openclaw/workspace/secrets/asana.env`; the old collector
  (`api/asana.js`, 151 lines) is plain REST against workspace/section GIDs.
- **Obsidian/granola**: meeting notes in `/Users/admin/obsidian/Meetings`
  (markdown; the old `api/obsidian.js` scan logic ports to Python directly).
- **Item schema + scoring**: the triage shape is good — keep it:
  `{id, source, title, subtitle, snippet, ts, ageHours, score, meta:{url,…},
  actions}`; port each collector's scoring heuristics as-is (e.g. gmail:
  unread+3, important+2, <6h+2/<24h+1, external sender+1).
- **UI overlay pattern**: the Cron tab (`frontend-overrides/js/cron.js`) proves
  the add-a-tab-without-touching-`frontend/` pattern. `frontend/` is rsync
  --delete'd from Odysseus; durable code lives in `frontend-overrides/` only.
- **Spinoff pattern**: `research.spinoff` mints a chat session and seeds its
  gateway thread with content before returning the session id. Reuse for
  "Hand to Gary".

## Architecture

```
backend/inbox.py  →  backend/inbox/ package
  __init__.py          router (same /api/items URL contract as the proxy)
  sources/gmail.py     himalaya INBOX unread → items
  sources/slack.py     signals file → items; staleness guard; mark-read
  sources/asana.py     PAT REST → my tasks in Backlog/In Progress/Review
  sources/obsidian.py  recent meeting notes with open follow-ups → items
  state.py             dismissed / snoozed / reviewed → .data/inbox-state.json
frontend-overrides/js/inbox.js   Inbox tab; styles in workspace.css
```

### Endpoints

- `GET /api/items?sources=a,b&limit=N` →
  `{items, total, sources: {name: count}, errors: {name: msg}, generatedAt}`.
  All sources fetched concurrently; per-source isolation (a failure becomes an
  `errors` entry, never an empty feed); results filtered against
  dismissed/snoozed state, merged, sorted `score desc, ageHours asc`.
  Per-source in-memory cache, 60s TTL.
- `POST /api/items/action` `{source, id, action, until?}` — see Actions.
- `POST /api/items/spinoff` `{source, id}` → `{session_id}` — seeds a chat
  session with the item's content (research-spinoff reuse).

### Actions

| action | sources | effect |
|---|---|---|
| `archive` | gmail | himalaya move — same code path as the Email tab |
| `mark_read` | slack | `conversations.mark` with keychain xoxc/xoxd |
| `complete` | asana | `PUT /tasks/{gid}` `completed: true` |
| `reviewed` | obsidian | local state only |
| `dismiss` | all | local, permanent hide |
| `snooze` | all | local, `until` epoch; presets in UI: later today / tomorrow / next week |

`open` is client-side: slack/asana native URLs from `meta.url`, obsidian
`obsidian://open?path=…`. Gmail: himalaya envelopes don't carry `Message-ID`
(verified — only `message read` returns it), so on Open the UI lazily calls the
existing `/api/email/read/{uid}?mark_seen=false`, takes `message_id`, and opens
`https://mail.google.com/mail/u/0/#search/rfc822msgid:<message_id>`.

Deferred (explicitly out of v1): bulk actions, flagging, keyboard navigation,
gmail trash.

### Slack staleness guard

If the signals file mtime exceeds ~24h (`SLACK_STALE_MIN` env override), kick
`ai.openclaw.slack-refresh` via `launchctl kickstart` (non-blocking) and set
`errors.slack = "signals stale (refresh kicked)"` so the UI shows a warning
chip while still rendering the stale items.

### UI

New icon-rail tab "Inbox" injected by `frontend-overrides/js/inbox.js`:
- Card list, score order: source chip (`.email-tag-*` colors exist in
  workspace.css), title, subtitle, snippet, relative age.
- Card actions: primary (per source) · snooze · dismiss · open · Hand to Gary.
- Header: per-source count chips that double as filters + a refresh button.
- Empty state: "Inbox zero" with per-source error/stale chips if any.
- Must work in the phone PWA (safe-area handling already in workspace.css).

## Error handling

- Missing creds (no `asana.env`, locked keychain, no signals file): that source
  self-disables for the session with a hint in `errors`, merge proceeds.
- Action failures return `{ok: false, error}` with a 502; the UI keeps the card
  and toasts the error.
- Snoozed/dismissed state writes are atomic (temp file + `os.replace`, same as
  `sessions_store`).

## Testing

- Unit: each source's mapper + scorer against fixture data (sample himalaya
  JSON, signals JSON, Asana task JSON, meeting markdown) → expected items;
  state-store round-trip incl. snooze expiry; merge/sort/filter logic.
- Live smoke before commit: `GET /api/items` with all sources, each action
  against a real item, spinoff session seeded, stale-slack path, error path
  (rename asana.env temporarily).

## Decommission (after smoke test passes)

- `launchctl bootout gui/501/ai.openclaw.triage-dashboard` and delete its plist.
- `~/.openclaw/workspace/triage-dashboard/` stays on disk (user may delete later).
- `ai.openclaw.slack-refresh` STAYS — it is now an Inbox dependency.
- Remove the old `TRIAGE_URL` config + httpx proxy code.

## Decisions log

- Approach: native Python collectors (chosen over node sidecar / agent-built
  feed) — one runtime, testable, kills the wedge bug class.
- Gmail via himalaya, not googleapis — actions already exist, no OAuth refresh.
- Slack reads the signals file rather than porting the 258-line web-API client;
  only mark-read talks to Slack directly.
- UI is a new tab (not the Email-UI adapter, not a landing widget).
- Action model: one primary action per source + dismiss/snooze/open + Hand to
  Gary (user-approved 2026-06-05).
