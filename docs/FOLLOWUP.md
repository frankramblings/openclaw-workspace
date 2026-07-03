# Follow-up promises

When Gary starts background work from a web chat and promises to report back
("I'll publish + link it the moment it lands"), the promise used to be
unfulfillable: once his turn ended, nothing could post a follow-up. The
followup machinery fixes that — the completion (or failure, or silence) of a
background task drives a **real agent turn** in the same chat session,
delivered through the normal live stream, toast, and OS notification.

## Usage

Run the background command through the wrapper instead of bare:

```bash
bin/followup run --session <session> --label "render 566" [--deadline 4h] -- <command...>
```

- `--session` — the web chat's 12-hex id **or** its gateway sessionKey
  (`agent:main:web-…`); both resolve.
- `--label` — short human name for the task; appears in the ⚙️ card and the
  seed Gary receives.
- `--deadline` — backstop timer (`90s`, `45m`, `4h`, `2d`; default `4h`,
  `0` disables). If the wrapper never pings back (hard crash, reboot), the
  backend fires an honest "the task never reported back" turn at the
  deadline instead of staying silent forever.
- `--url` / `FOLLOWUP_URL` — workspace base URL (default
  `http://127.0.0.1:8800`).
- `--token` / `FOLLOWUP_TOKEN` (falls back to `WORKSPACE_AUTH_TOKEN`) — sent
  as `X-Workspace-Token`. Required when the deploy sets a workspace auth
  token; `/api/followup/register` and `/api/followup/complete` are exempt
  from the cookie gate but enforce this token themselves.

The wrapper streams the command's output through untouched and exits with
the command's exit code. Success AND failure both ping completion (including
"command could not launch", exit 127); the ping carries the exit code,
duration, and the last ~50 lines (≤4 KB) of output. If the backend is down,
the command still runs — the deadline sweeper is the backstop.

## What happens on completion

1. The backend seeds a turn in the same session: a compact system card
   (⚙️ *Background task · render 566 — exit 0 after 12m*) plus a prompt
   telling Gary to inspect the actual result and report honestly.
2. Gary wakes, checks the artifacts (he has tools), and posts the follow-up
   with real links/numbers — or an honest failure report.
3. Delivery uses the existing machinery: an open thread streams it live, a
   backgrounded tab gets the toast + OS notification, a closed client sees
   it on next open. Signal remains the phone-is-locked channel.

If you're mid-conversation in that session, the follow-up politely waits for
your turn to finish (up to 30 min per attempt) before firing.

## States & debugging

`GET /api/followup/list` shows every promise:
`pending → completed | overdue | failed` (failed = session deleted, gateway
never acked after retries, or session busy too long; the `error` field says
which). Promises survive backend restarts (`.data/followups.json`); pending
work past its deadline fires immediately on the next 30s sweep after boot.

## Gary adoption note

Add to Gary's OpenClaw workspace instructions (lives outside this repo):

> When you start background work from a web chat and promise to report back,
> run it through `bin/followup run --session <this chat's session id>
> --label "<short name>" -- <command>` instead of running the command bare.
> The workspace will wake you in the same chat when it finishes (or goes
> silent), so the promise keeps itself.
