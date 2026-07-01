# Workspace Live Jobs — Design

Date: 2026-06-30
Status: Approved (core + placement), pending spec review

## Problem

When the agent (Gary) spawns a long-running **detached** task — a multi-GB file
pull, an ffprobe verify, a Wistia feed download, a batch script — the workspace
gives no live feedback. The agent says "I'll confirm when it's done" and Frank
waits blind, often with **several such processes running at once**. He wants a
live progress bar in the workspace for "this kinda stuff."

## Goal

A reusable **background-job progress primitive**: any detached task reports
`% / bytes / ETA` into a registry, and the workspace renders a live progress bar.
Downloads are the first consumer, not the only one. Cron jobs, verifies, batch
scripts, and future long tasks all plug into the same contract.

Non-goals: replacing the terminal panel; a general job *scheduler* (this only
*reports* progress, it does not queue or manage execution); progress for
in-band/streaming chat turns (already covered by existing SSE).

## Placement decision

- Progress **bars render in-chat**, inside the thread that spawned the job. With
  multiple concurrent processes this keeps each job tied to its context.
- A **small global badge** (a count, e.g. `⏳ 2`) sits in the app chrome. Tapping
  it navigates to the thread hosting a running job. This closes the one gap of
  in-chat-only rendering: jobs in other threads staying invisible while Frank is
  elsewhere.

## Architecture — four independently testable layers

### Layer 1 — Job registry (the primitive)

A `bin/job` helper writes **atomic** JSON status files to
`~/.openclaw/workspace/tmp/jobs/<id>.json`. This file *is* the entire contract;
every other layer only reads it.

Subcommands:
- `job start --label "Composite pull" --kind download [--total-bytes N] [--thread <threadId>]`
  → creates the file, prints the generated `<id>` on stdout.
- `job update <id> [--bytes N] [--pct P] [--detail "…"]` → merges fields,
  recomputes `rate`/`eta` from the delta since `updatedAt`, rewrites atomically
  (write temp + `os.replace`).
- `job done <id> [--detail "…"]` → sets `status=done`, `pct=100`.
- `job fail <id> --error "…"` → sets `status=failed`.

Record schema (`tmp/jobs/<id>.json`):

```json
{
  "id": "j_20260630_ab12cd",
  "label": "Composite pull",
  "kind": "download",
  "thread": "web-5b93af69c874",   // stable thread/session id (not display label)
  "status": "running",          // running | done | failed
  "pct": 41.2,                   // null when total unknown
  "bytesDone": 1189085184,
  "bytesTotal": 2969283372,      // null when unknown (chunked/no Content-Length)
  "rate": 24117248,              // bytes/sec, smoothed
  "eta": 74,                     // seconds remaining, null when unknown
  "detail": "media/wistia-feeds/…/composite_main.mp4",
  "error": null,
  "startedAt": "2026-06-30T22:38:01-04:00",
  "updatedAt": "2026-06-30T22:39:15-04:00"
}
```

`thread` is optional metadata the spawner passes so the frontend can attach the
bar to the right chat and drive the global badge's jump-to-thread. When absent,
the bar shows only in the global badge list.

Retention: `done`/`failed` files linger for a short window (default 60s of wall
time after `updatedAt`) so the UI can show the completed state, then a sweep on
the next registry read removes stale terminal files. `bin/job` is pure I/O with
no daemon.

### Layer 2 — Backend router (`backend/jobs.py`)

FastAPI router mirroring `backend/research.py`'s SSE pattern, mounted in
`backend/app.py`:

- `GET /api/jobs` → `{ jobs: [ …records… ] }` — active plus not-yet-swept
  terminal jobs, newest first.
- `GET /api/jobs/stream` → `text/event-stream` (`StreamingResponse`). Emits the
  current snapshot on connect, then a `data:`-framed record list on every change.
  Change detection: a `watchfiles`/`asyncio` poll of `tmp/jobs/` (250–500 ms), or
  wiring through the existing `event_store` pub/sub if a writer notifies it.
  Poll is the default — zero coupling to `bin/job`, which stays a dumb writer.

Fail-soft: malformed/partial JSON files are skipped, never 500 the stream.

### Layer 3 — Frontend (`frontend-overrides/js/redesign/live/jobs.js` + panel)

- A `jobs.js` live module that opens `/api/jobs/stream` via the existing
  `openSSE` helper in `live/api.js`, keeps a `state.live.jobs` map, and renders:
  - **In-chat bar(s):** for jobs whose `thread` matches the open thread, a slim
    bar (label, `pct`, `rate`, `eta`, `detail`) styled after the Deep Research
    running panel. `done` → brief green check; `failed` → red + error. Auto-fades
    a few seconds after terminal state.
  - **Global badge:** a count of running jobs in the app chrome. Click → navigate
    to the thread of the (oldest running) job. Hidden at zero.
- Fail-soft with mock fallback, same convention as `research.js`.

### Layer 4 — First consumer (`bin/job-download`)

`job-download <url> <dest> [--label "…"] [--thread "…"] [--verify]`:
1. `job start` (derives `--total-bytes` from a `HEAD`/`Content-Length` when
   available).
2. Resume+retry curl (`-C -`, retry loop) to `dest`.
3. Background poller: every ~1s, `job update <id> --bytes $(stat dest)`.
4. On finish: optional `ffprobe` verify → `job done` (or `job fail` on mismatch).

This replaces the ad-hoc detached curl currently hand-written for pulls like the
2.77 GB composite, and exercises Layers 1–3 end-to-end.

## Data flow

```
bin/job-download ──writes──► tmp/jobs/<id>.json ──polled by──► /api/jobs/stream (SSE)
       │ (curl + poller)              ▲                               │
       └── job start/update/done ─────┘                               ▼
                                                     jobs.js ──► in-chat bar + global badge
```

## Error handling

- `bin/job` writes atomically (temp + `os.replace`); readers never see partial.
- Backend skips unparseable files; SSE never crashes on one bad record.
- A crashed `job-download` leaves a `running` file with a stale `updatedAt`; the
  frontend marks jobs "stalled" (greyed, "no update in Ns") after a threshold so
  a dead job doesn't spin forever. It is not auto-failed (the writer owns state).
- Frontend fails soft to mock/empty; a dropped SSE reconnects.

## Testing

- **Layer 1:** unit-test `bin/job` — start/update/done/fail produce correct JSON;
  atomic write leaves no partial; rate/eta math; retention sweep.
- **Layer 2:** FastAPI test client — `/api/jobs` shape; `/api/jobs/stream` emits
  snapshot + updates; malformed file is skipped not fatal.
- **Layer 3:** DOM test (existing `__tests__` harness) — bar renders for matching
  thread, badge count reflects running jobs, terminal states fade.
- **Layer 4:** integration against a small local file over the media server —
  full start→progress→verify→done path; simulated interruption resumes.

## Deploy

Backend change → `systemctl --user restart openclaw-workspace.service`.
Frontend override → `scripts/sync-frontend.sh` (per existing workflow).
