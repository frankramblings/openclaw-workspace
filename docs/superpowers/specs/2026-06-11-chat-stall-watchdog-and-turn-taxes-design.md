# Chat Stall Watchdog + Per-Turn Tax Removal — Design

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan
**Scope:** openclaw-workspace only (backend `bridge.py`/`app.py`/`config.py` + `frontend-overrides/` SPA). No gateway source changes, no gateway restart. Deploy = fast uvicorn restart + `./scripts/sync-frontend.sh`.

## Problem

User-reported chat pain in the workspace web UI, in priority order:

1. **Stalls** — sometimes a turn hangs indefinitely. Root cause: `_relay_events` (`backend/bridge.py:583`) reads the gateway WebSocket with **no timeout**, and the WS deliberately disables pings (a keepalive timeout would kill the WS mid-turn). When codex/OpenAI stalls and the run never reaches lifecycle end, the SSE stream — and the SPA spinner — hang forever with zero signal. The only remedy is the manual Stop button, with no hint about when to use it.
2. **Send → first text is slow** — dominated by gpt-5.5 thinking time (codex returns no reasoning summaries to display), but made worse by removable per-turn taxes (below).
3. **Replies stream slowly** — gpt-5.5 token rate; out of scope here (the model picker already offers gpt-5.4-mini; a per-chat speed/thinking toggle is a known follow-up, see Out of Scope).

Verified per-turn taxes in our own middle layer:

- **Title generation races the real turn on the big model.** On a new chat's first message, `app.py:311` fires `_generate_ai_title` concurrently with the user's turn, and `_collect_brain_text` (`app.py:169`) calls `bridge.stream_turn` with **no `model_ref`** — so a throwaway 6-word title runs as a full gpt-5.5 medium-thinking turn through the same gateway + codex app-server, competing with the real reply on an 8GB box.
- **The late-reply poll adds a flat 2–10s.** When the agent delivers its reply via the `message` tool (text lands in the transcript only after lifecycle end), `_late_reply` (`app.py:226`) sleeps **2s before the first check**, then polls at 2s intervals. The reply already exists; we are just slow to fetch it.
- **No turn telemetry.** We have never measured where a turn's wall-clock goes, so every tuning conversation is guesswork.

## Design

### 1. Stall watchdog — liveness tick (`bridge.py::_relay_events`)

- Wrap the WS read in `asyncio.wait_for(_recv_json(ws), timeout=20)` (tick fixed at 20s).
- **Run-activity definition:** a frame resets the stall clock iff it is scoped to this run (`payload.runId == run_id`) **or** it is `codex_app_server.*` runtime metadata (currently ignored at `bridge.py:575`; it becomes our liveness signal — e.g. mid-turn compaction keeps emitting these, so compaction reads as "alive", not "stalled"). Frames from other runs (cron, heartbeats) do **not** reset the clock.
- Once run-silence exceeds the **notice threshold (45s)**, each further silent tick yields a new SSE frame:
  `{"type": "stall", "silent_for": <int seconds>}`
  These frames double as proxy keepalives so the Tailscale Serve path (:8443) can't idle-kill a quiet stream.
- When run-silence exceeds the **hard cap (240s)**, `_relay_events` raises internal `_RunStalled` for the caller to handle.

### 2. Stall watchdog — abort + auto-retry once (`bridge.py::stream_turn`)

On `_RunStalled`:

1. `chat.abort {sessionKey, runId}` — same verified call the Stop button uses (`app.py:513`). Best-effort: tolerate failure (the gateway itself may be wedged).
2. Invalidate the warm socket and close it; the next connection is guaranteed fresh.
3. If this was the **first** stall of the turn: emit
   `{"type": "stall_retry"}`
   then resend via `_open_turn(..., allow_warm=False)`. The retry naturally gets a **fresh `idempotencyKey`** (`_open_turn` generates one per call) — this is required: reusing the old key would trip the gateway's transcript idempotency dedup and silently no-op the retry. Relay the new run with the same watchdog, retry flag set.
4. If the **retry also** hits the cap: abort again and emit an honest terminal error card (`type: "tool_output"`, `tool: "agent"`, `exit_code: 1`):
   *"no gateway activity for 4m, retried once — codex looks stalled; try again or check the status dot"* — then end the turn.
- The existing late-reply poll in `app.py::gen()` still runs after the stream ends, so a reply that landed in the transcript despite the stall is recovered.
- Known acceptable risk (user-approved): if the stalled run had already performed side effects (sent an email, messaged someone), the auto-retry can repeat them. Worst-case wait before the terminal error ≈ 2 × cap ≈ 8 min.

### 3. Stall watchdog — frontend (`frontend-overrides/js/chat.js` + ui)

- **Elapsed timer** on the pending assistant bubble (mm:ss), driven by the existing visibility-guarded 250ms ticker — no new intervals (perf-audit rule).
- On `stall` frames: spinner caption becomes *"still waiting — no activity for Ns"*.
- On `stall_retry`: caption becomes *"stalled — retrying on a fresh connection…"* (explains why progress resets).
- Unknown frame types are already ignored by chat.js, so stale cached SPAs degrade gracefully. Deploy via `sync-frontend.sh` (CACHE_NAME now auto-versions).

### 4. Titler off the hot path (`app.py`, `config.py`)

- `_collect_brain_text` gains a `model_ref` parameter (threads through to `stream_turn`, which already supports it).
- `_generate_ai_title` passes `config.title_model()` — default **`openai/gpt-5.4-mini`**, env override `WORKSPACE_TITLE_MODEL`. The bridge's `_pinned` cache means the titler session is patched once per connection, not per title.
- The title task stays concurrent (it no longer meaningfully competes once it's on mini).

### 5. Faster late-reply pickup (`app.py::_late_reply`)

- Replace `attempts=5, delay_s=2.0` with a backoff schedule: `0.3, 0.5, 1, 2, 2, 2, 2` seconds (~10s total window unchanged, first hit at 0.3s instead of 2s).
- Same exception tolerance (transient WS trouble → keep polling).

### 6. Per-turn timing log (`bridge.py`, `app.py`)

- `stream_turn` records monotonic timestamps into the existing `run_info` dict: `t_send` (chat.send written), `t_ack`, `t_first_frame` (first run-scoped frame), `t_first_text` (first non-thinking delta), `t_end` (lifecycle end/error), plus `stalled` / `retried` booleans.
- `app.py::gen()` adds `t_late` when the late-reply poll supplied the text, then appends **one JSONL line** per turn to `.data/turn_timings.jsonl` (session key, model ref, the deltas in ms, outcome).
- Size guard: before append, if the file exceeds 2MB rename to `.old` (single-generation rotation). No new dependencies, no logger config changes (uvicorn runs at warning level).

## Configuration

| Knob | Default | Env override |
|---|---|---|
| Stall notice threshold | 45s | `WORKSPACE_STALL_NOTICE` |
| Stall hard cap | 240s | `WORKSPACE_STALL_CAP` |
| Watchdog tick | 20s | fixed (not configurable) |
| Titler model | `openai/gpt-5.4-mini` | `WORKSPACE_TITLE_MODEL` |

Constants live in `backend/config.py` alongside the existing env-driven settings.

## Error handling

- `chat.abort` failure during stall recovery: log, proceed with reconnect anyway (the abort is best-effort cleanup of a zombie run).
- Fresh reconnect during retry fails (gateway down): the existing `stream_turn` error paths already emit the monitor-aware disconnect message (`_disconnect_message`); no new handling.
- Timing-log write failure: swallowed (`contextlib.suppress`) — telemetry must never break a turn.
- `stall`/`stall_retry` frames must NOT set `failed=True` in `app.py::gen()`'s frame observation (they are not `tool_output` error frames, so no change needed — noted to prevent regression).

## Testing

- **Backend (pytest, `backend/tests/`):** fake-WS fixtures feeding `_relay_events` / `stream_turn`:
  - silence past notice → `stall` frames with growing `silent_for`;
  - run-scoped frame or `codex_app_server.*` frame resets the clock; other-run frames don't;
  - silence past cap → `chat.abort` called once, exactly one retry with a different `idempotencyKey`, `stall_retry` emitted;
  - retry stalls too → second abort + terminal error card, generator ends;
  - `_late_reply` backoff schedule honored; first poll ≤ 0.5s (mock sleep);
  - titler passes the configured `model_ref`;
  - timing JSONL line shape + 2MB rotation.
- **Frontend:** `node --input-type=module --check` on touched files + user browser smoke (no headless Chrome on this box). Smoke: send a message and watch the elapsed timer; to see the stall UI for real, temporarily set `WORKSPACE_STALL_NOTICE=5` in the dev environment and send a turn that thinks long enough — no special debug machinery.

## Out of scope (explicit follow-ups)

- **Per-chat speed/thinking toggle:** `chat.send` accepts unused `thinking` (`off/minimal/low/medium/high`) and `fastMode` overrides — a Fast/Normal/Deep UI control is the next lever for send→first-text. Deferred by user choice (stalls first).
- **Bootstrap context trim:** ~60KB (~15k tokens) of workspace .md files ride along via `contextInjection: "always"` (AGENTS 9K, TOOLS 13.6K, OPERATING-MANUAL 12K, MEMORY 9.7K, …). Real prefill/reasoning cost but a quality/behavior tradeoff — revisit once `turn_timings.jsonl` quantifies it.
- **Gateway-side anything** (compaction tuning, codex app-server supervision). The watchdog only makes those visible.
