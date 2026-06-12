# Speed Toggle + Honest Spinner — Design

**Date:** 2026-06-11
**Status:** Approved design, pending implementation plan
**Scope:** openclaw-workspace only (backend `bridge.py`/`app.py`/`sessions_store.py` + `frontend-overrides/` SPA). No gateway changes, no gateway restart. Deploy = fast uvicorn restart + `./scripts/sync-frontend.sh`.

## Problem

Telemetry from the first live turn (turn_timings.jsonl, 2026-06-11): `ack_ms` 45, `first_frame_ms` 2267, `first_text_ms` 15637. The middle layer is effectively free; ~86% of the wait is gpt-5.5 medium-thinking time with nothing to show (codex returns no reasoning text). Two consequences:

1. There is no way to trade answer depth for latency per chat. The gateway's `chat.send` accepts a verified per-turn `thinking` override (`off/minimal/low/medium/high` — `thinkingLevelOverride: p.thinking` in the installed dist) that nothing uses.
2. The SPA's wait spinner shows canned staged guesses ("Processing request" → 10s → "Checking model endpoint" → "Still waiting for model") even though the backend *knows* the run is alive at ~2.3s (`t_first_frame`). The captions are fiction; the user just watched them mislabel a healthy turn.

User decision (2026-06-11): the toggle controls **thinking only** — it never changes the model. Model choice stays in the existing picker; the two controls are orthogonal. Fast on gpt-5.5 should land ~3–6s to first text.

## Design

### 1. Per-chat speed setting (`sessions_store.py`, `app.py`)

- New session-record field `speed`: `"fast" | "normal" | "deep"`, default `"normal"`.
- `sessions_store.create()` writes `"speed": "normal"`; `update()`'s `allowed` set gains `"speed"`. Records created before this change lack the key — every reader uses `.get("speed") or "normal"`.
- The existing session-update endpoint (`POST /api/sessions/{id}`, the one the model picker uses) accepts a `speed` form field, validated against the three values (invalid → ignored, like other bad fields). The session-list/detail responses include it.

### 2. Backend pass-through (`app.py`, `bridge.py`)

- `app.py::chat_stream` resolves `speed = (rec or {}).get("speed") or "normal"` and maps:
  - `fast` → `thinking="low"`
  - `deep` → `thinking="high"`
  - `normal` → `thinking=None` → **no param sent; chat.send payload byte-identical to today** (zero new risk on the default path).
- `bridge.stream_turn` and `_open_turn` gain `thinking: str | None = None`. When set, `_open_turn` adds `"thinking": thinking` to `send_params`. Per-turn only — nothing persisted gateway-side, Signal untouched. The stall-retry `_open_turn` call passes the same value (a retried turn keeps its speed).
- Titler unchanged (already pinned to mini; its 6-word output doesn't need a thinking override).
- Failure mode: if the gateway rejects the param, the existing `_ChatSendRejected` path already surfaces an honest error card. No new handling.

### 3. Speed toggle UI (`frontend-overrides/`)

- Compact three-state control in the composer, next to the existing model picker: **⚡ Fast / Normal / 🧠 Deep** (one button cycling the three states, label+title showing the active one — smallest footprint; matches the composer's existing toggle idiom, e.g. the web-search globe).
- On change: `POST /api/sessions/{id}` with `speed=<value>` (the model picker's exact pattern). On chat load: read `speed` from the session record and set the control. New chats start `normal`.
- Works with any picked model — thinking levels are gateway-generic. No per-model gating in v1.

### 4. Honest spinner: "Model is thinking…" (`bridge.py`, `chat.js`)

- `_relay_events` emits a new one-shot SSE frame `{"type": "run_alive"}` immediately after stamping `t_first_frame` (i.e., on the FIRST run-activity frame; the `setdefault` result tells us whether this frame was the first — emit only then).
- `chat.js`: on `run_alive` (foreground, no accumulated text): `spinner.updateMessage('Model is thinking…')` and set a closure flag `_runAlive = true`. The canned staged `setTimeout` messages ("Checking model endpoint", "Still waiting for model", endpoint-offline countdown) each check `_runAlive` and skip when set — real signal replaces guesses. Stall captions still overwrite (they're also real signal). `run_alive` also calls `_extendTimeout()` (it's proof of life, same as stall frames).
- Old cached SPAs ignore unknown frame types — graceful degradation.

## Configuration

None. No new env vars; the three speed values are fixed. (The thinking-level strings are the gateway's own enum; if it ever grows, this maps 1:1 trivially.)

## Error handling

- Invalid `speed` posted → ignored, record unchanged (matches existing field-validation behavior).
- Gateway rejects `thinking` → `_ChatSendRejected` error card (existing path).
- `run_alive` must NOT set `failed=True` or `text_seen=True` in `gen()` (it's neither an error frame nor a delta — no code change needed, noted to prevent regression).
- Telemetry: no new fields. (`first_frame_ms` already captures what `run_alive` signals; speed arrives via the session's `model`+`speed` if ever needed — YAGNI for now.)

## Testing

- **Backend (pytest):**
  - speed→thinking mapping incl. default-normal-sends-no-param (assert `"thinking" not in send_params`);
  - `_open_turn` puts `thinking` into chat.send params when set;
  - stall retry preserves the thinking value;
  - `run_alive` emitted exactly once per relay, before the first data frame's SSE, and not at all when the run never produces an activity frame;
  - sessions_store round-trips `speed`, update endpoint validates it.
- **Frontend:** `node --input-type=module --check` + user browser smoke (toggle cycles + persists across reload; Fast turn shows "Model is thinking…" at ~2s and first text in ~3–6s).

## Out of scope

- `fastMode` (codex semantics unverified — YAGNI).
- Per-model thinking-level gating (e.g. hiding Deep on non-reasoning models).
- Signal-side thinking changes; gateway config changes.
- Bootstrap context trim (separate decision, after more telemetry).
