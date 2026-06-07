# Control-UI Borrowings — Design

**Date:** 2026-06-06
**Status:** Approved
**Scope:** Six features borrowed from OpenClaw's stock Control UI (`/Users/admin/openclaw/ui/src/`), adapted to the workspace's backend-adapter + frontend-overrides architecture.

## Goal

Close the most painful gaps between the workspace UI and the stock gateway Control UI:

1. **Stop button** — abort a running turn (`chat.abort`)
2. **Restart/health awareness** — know when the gateway is restarting/down/updatable
3. **Session hygiene** — gateway sessions/transcripts deleted with their chats; proper `sessions.patch` for model override
4. **Thinking card** — render the reasoning the bridge currently drops
5. **Cron run history** — per-job execution log (`cron.runs`)
6. **Skills toggles** — enable/disable skills (`skills.update`, no keys/ClawHub)

All protocol shapes below were verified against the OpenClaw source clone (citations are `file:line` in `/Users/admin/openclaw`).

## Decisions made (with user)

- **Health architecture:** persistent monitor WS in the backend + frontend polls a cheap status endpoint every ~30s. (Rejected: on-demand-only — misses idle restarts; SSE push — plumbing overkill.)
- **Delete policy:** chat delete always hard-deletes the gateway session with `deleteTranscript: true`, best-effort. (Rejected: per-delete confirm; manual purge only.)
- **Skills scope:** enable/disable only. No API-key editing (UI is unauthenticated on the tailnet), no ClawHub install.
- **Thinking display:** collapsed expandable card, tool-card style. (Rejected: indicator-only; inline dimmed text.)

## 0. Common architecture

Backend adapters in `backend/`, frontend changes in `frontend-overrides/` (applied by `scripts/sync-frontend.sh`). One new long-lived component:

### `backend/monitor.py` — persistent gateway monitor

- Single read-only WS client, asyncio task started on FastAPI startup. Separate from the per-turn bridge.
- Auto-reconnect with capped backoff (1s doubling to 30s cap — gateway cold-boots take 4–5 min on this host; the monitor just keeps retrying calmly).
- Listens for broadcast events:
  - `shutdown` → `{reason, restartExpectedMs?}` — emitted just before gateway close (`src/gateway/server-close.ts:161-164`)
  - `update-available` → `{version, ...} | null`
- Calls `health` lazily (on status request, cached ~60s). Response includes `agents[]` (with heartbeat + session counts), `sessions.count`, `heartbeatSeconds` (`src/gateway/server-methods/health.ts:11-29`).
- State machine: `ok` → `restarting` (shutdown event seen) → `down` (WS not reconnectable) → `ok` (reconnected). Initial state before first connect: `down`.
- Failure isolation: monitor errors NEVER crash or block the app; worst case the status endpoint reports `down`.

### New endpoint

`GET /api/gateway/status` → `{state, since, updateAvailable, agents, sessionCount}`. Frontend polls every 30s + on window-focus.

## 1. Stop button (`chat.abort`)

**Protocol (verified):** `chat.abort {sessionKey, runId?}` → `{runIds: string[]}`; the client then sees a `chat` event with `state: "aborted"` (`src/gateway/protocol/schema/logs-chat.ts:54-60`).

- `app.py` tracks `_active_runs[session_id] = (sessionKey, runId)` — set when the bridge receives the `chat.send` ack (runId already captured today), cleared on turn end.
- New `POST /api/chat/{session_id}/abort`: opens a short-lived authenticated WS, sends `chat.abort`. If no runId is recorded (ack never landed), omit it — aborts all runs on that sessionKey, acceptable for a single-user UI.
- Bridge: map `state: "aborted"` to a final "⏹ stopped" SSE frame (not an error).
- Frontend: stop button visible in the chat input area while a stream is active. Note: Odysseus's existing stop affordance only closes the SSE — the gateway turn keeps running; this wires a real abort.

## 2. Restart/health awareness

- Header **status dot**: green `ok` / amber `restarting` / red `down`. Tooltip shows since-when + agent/session counts.
- Dismissible **banner** when `restarting` or `down`; "update vX available" pill when `update-available` is set.
- Injected via `frontend-overrides` (same pattern as the Cron tab rail button + modal).
- **Bridge change:** mid-turn `ConnectionClosed` → explicit SSE card "gateway restarted mid-turn — your message may not have completed" (message says "restarting" when the monitor state confirms it), replacing today's silent dead stream.

## 3. Session hygiene

**Protocol (verified):**
- `sessions.delete {key, deleteTranscript?}` → `{ok, key, deleted, archived[]}`; `deleteTranscript` defaults to **true** (`src/gateway/protocol/schema/sessions.ts:183-191`). Pass it explicitly anyway.
- `sessions.patch {key, model, ...}` → `{ok, path, key, entry, resolved: {modelProvider, model}}` (`src/gateway/protocol/schema/sessions.ts:131-173`).
- `sessions.list {limit?, search?, ...}` → `sessions[]` with `key`, `updatedAt`, `label`, `model`, token counts (`src/gateway/protocol/schema/sessions.ts:38-60`).

Changes:

1. **Chat delete** (`app.py` session DELETE) → best-effort gateway `sessions.delete {key, deleteTranscript: true}` for the chat's `sessionKey`. Research threads aren't recorded in chat metadata, so the orphan sweep (below) covers them. Gateway unreachable → local delete still succeeds; log and continue.
2. **Model override** switches to `sessions.patch {key, model}`, falling back to the `sessions.create` upsert when the entry doesn't exist yet (fresh chats have no session entry until their first turn — the likely reason `create` was used originally).
3. **One-time orphan sweep:** `scripts/purge_orphan_sessions.py` — `sessions.list`, keep keys starting `agent:main:web`, subtract keys referenced in `.data/sessions.json` and live utility keys (`agent:main:web-titler`), `--dry-run` by default (prints the would-delete list), `--apply` to delete. A maintenance script, not UI.

## 4. Thinking card

**Protocol (verified):** reasoning arrives in the `agent` event stream the bridge already parses — `stream: "item"`, `kind: "analysis"`, `phase: start|update|end`, fields `itemId, title, status, summary` (`src/infra/agent-events.ts:21-27`). The bridge currently filters items to `kind ∈ {command, tool}`.

- Bridge: also accept `kind: "analysis"`; emit `{"delta": <reasoning text>, "thinking": true}` SSE frames. **The SPA already has the exact approved UI**: chat.js wraps `thinking: true` deltas in `<think>` tags (chat.js:1370-1376) and markdown.js renders them as a collapsed, expandable "View thinking process" section with an elapsed timer (markdown.js:275). No frontend changes; no new SSE frame types.

**Flagged uncertainty:** the exact field carrying full reasoning *text* for gpt-5.5 over protocol v4 (`summary` on update events vs. a separate delta) is not fully confirmed from source. **First implementation step is a one-turn live probe** logging raw `analysis` events; the card renders whatever text field the probe confirms. Worst case (title + summary only) the card still works as a stall-vs-thinking signal.

**Probe outcome (2026-06-07):** gpt-5.5/v4 analysis events carry only `{title: "Reasoning", status}` — no text in any field. The bridge mapping landed inert-but-forward-compatible; textless frames emit nothing.

## 5. Cron run history (`cron.runs`)

**Protocol (verified):** `cron.runs {scope: "job", id, limit (1–200), status?}` → entries `{ts, jobId, status: ok|error|skipped, error?, summary?, durationMs?, runAtMs?, delivered?, deliveryStatus?, usage?, jobName?}` (`src/gateway/protocol/schema/cron.ts:326-378`). `jobId` matches `cron.list` entry `id`.

- `backend/cron.py`: `GET /api/cron/{job_id}/runs?limit=50` → mapped list (ts, status, duration, summary, error, delivered).
- `frontend-overrides/js/cron.js`: "History" section in the existing job modal — status icon, relative time, duration, summary line, error text on failure. Read-only.

## 6. Skills toggles (`skills.update`)

**Protocol (verified):** `skills.update {skillKey, enabled}` → `{ok, skillKey, config}` (`src/gateway/server-methods/skills.ts:240-346`).

- `backend/skills.py`: `POST /api/skills/{skill_key}/enabled` body `{enabled: bool}`. Existing 501s for add/delete remain.
- Frontend: toggle per skill row; optimistic flip, revert + toast on gateway failure.
- Out of scope (deliberate): `apiKey`/`env` writes, ClawHub `skills.search`/`skills.install`.

## Error handling

- Every gateway write is best-effort: unreachable gateway → `{success: false, error}` + visible toast/card; never a crashed tab, never a blocked local operation.
- Monitor failures only ever degrade the status dot to red.
- Abort with a dead gateway: returns failure; the SSE stream's own disconnect handling (section 2) covers the user-visible state.

## Testing

- pytest on pure mappers, matching the existing style (11 mapper tests today): cron-run mapping, status payload shaping, abort/patch param builders, orphan-sweep filtering.
- Live smoke per feature, **batched into as few workspace restarts as possible** — each cold start is 100–190s on this host and stalls the codex brain (see hardware-constraint memory). Group backend changes so one restart smokes several features.

## Build order

1. `monitor.py` + `/api/gateway/status` + status dot/banner (foundation)
2. Stop button
3. Session hygiene (delete hook, `sessions.patch`, orphan-sweep script)
4. Thinking probe → thinking card
5. Cron run history
6. Skills toggles

Each lands independently; no feature depends on a later one.

## Out of scope (explicitly rejected during design)

- Config editor (`config.patch` from UI) — standing decision: gateway-write risk.
- Channels admin, node/device pairing, exec approvals, i18n — no audience on a single-user host.
- Usage tab (`sessions.usage*`) — was offered, not picked in this batch.
- Mounting the workspace inside the gateway's control-ui asset pipeline — sibling app on :8800 stays.
