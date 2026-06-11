# Chat Stall Watchdog + Per-Turn Tax Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect and recover from stalled chat turns in the workspace web UI (notice at 45s of gateway silence, abort + auto-retry once at 240s), and remove three per-turn taxes: titler on gpt-5.5, flat-2s late-reply poll, and zero turn telemetry.

**Architecture:** All changes live in `openclaw-workspace` — backend `bridge.py` (watchdog inside the WS→SSE relay, retry orchestration in `stream_turn`), `app.py` (titler model, late-reply backoff, timing JSONL), `config.py` (env knobs), plus two small SSE frame handlers in the SPA. No gateway source changes; deploy is a fast uvicorn restart + `sync-frontend.sh`.

**Tech Stack:** Python 3.14 / FastAPI / websockets / pytest (`backend/tests/`, fake-WS pattern from `test_bridge_relay.py`); vanilla-JS SPA in `frontend-overrides/`.

**Spec:** `docs/superpowers/specs/2026-06-11-chat-stall-watchdog-and-turn-taxes-design.md`

**House rules (memory-sourced, binding):**
- Repo has other sessions' uncommitted work — `git add` ONLY the files you touched, never `-A`.
- No headless Chrome on this box. Frontend verification = `node --input-type=module --check` + user browser smoke.
- Frontend deploy = `./scripts/sync-frontend.sh` (it also auto-stamps the sw.js CACHE_NAME).
- All commands run from `/Users/admin/openclaw-workspace`.

**New SSE frames (backend→SPA contract used throughout):**
- `{"type": "stall", "silent_for": <int seconds>}` — emitted while run-silence exceeds the notice threshold.
- `{"type": "stall_retry"}` — emitted once when the watchdog aborts a stalled run and resends.

---

### Task 1: Watchdog primitives in bridge.py + config knobs

**Files:**
- Modify: `backend/config.py` (after `TURN_TIMEOUT_S`, line 106)
- Modify: `backend/bridge.py` (imports; new helpers near `_ChatSendRejected`, line 95)
- Test: `backend/tests/test_stall_watchdog.py` (create)

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_stall_watchdog.py`:

```python
"""Stall watchdog: pure helpers + relay loop + stream_turn retry orchestration."""
import asyncio
import json

import pytest

from backend import bridge, config


# --- pure helpers ---------------------------------------------------------------

def test_is_run_activity_matches_own_run():
    assert bridge._is_run_activity({"runId": "r1"}, "r1")
    assert not bridge._is_run_activity({"runId": "other"}, "r1")


def test_is_run_activity_counts_codex_runtime_metadata():
    # codex_app_server.* streams are runtime-level liveness (mid-turn compaction
    # keeps emitting these) regardless of runId.
    assert bridge._is_run_activity({"stream": "codex_app_server.status"}, "r1")
    assert not bridge._is_run_activity({"stream": "lifecycle"}, "r1")
    assert not bridge._is_run_activity({}, "r1")


def test_stall_action_thresholds(monkeypatch):
    monkeypatch.setattr(config, "STALL_NOTICE_S", 45.0)
    monkeypatch.setattr(config, "STALL_CAP_S", 240.0)
    assert bridge._stall_action(10.0) is None
    assert bridge._stall_action(45.0) == "notice"
    assert bridge._stall_action(239.9) == "notice"
    assert bridge._stall_action(240.0) == "cap"
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/admin/openclaw-workspace && python3 -m pytest backend/tests/test_stall_watchdog.py -q`
Expected: FAIL — `AttributeError: module 'backend.bridge' has no attribute '_is_run_activity'`

- [ ] **Step 3: Add the config knobs** — in `backend/config.py`, directly under the `TURN_TIMEOUT_S` line (106):

```python
# Stall watchdog (workspace chat): run-silence thresholds for the bridge's
# WS relay. Notice → SSE "stall" frames; cap → abort + retry-once.
STALL_NOTICE_S = float(os.environ.get("WORKSPACE_STALL_NOTICE", "45"))
STALL_CAP_S = float(os.environ.get("WORKSPACE_STALL_CAP", "240"))
# Chat auto-titles run on a cheap model so they never race the user's real
# turn through codex on the big one.
TITLE_MODEL = os.environ.get("WORKSPACE_TITLE_MODEL", "openai/gpt-5.4-mini")
```

- [ ] **Step 4: Add the bridge primitives** — in `backend/bridge.py`:

(a) add `import time` to the stdlib import block (after `import json`).

(b) after the `_ChatSendRejected` class (below line 101), add:

```python
# Watchdog tick: how often the relay wakes to check run-silence. Fixed — the
# user-tunable knobs are config.STALL_NOTICE_S / STALL_CAP_S.
_STALL_TICK_S = 20.0


class _RunStalled(Exception):
    """No run-scoped gateway activity for STALL_CAP_S — the caller should
    abort the zombie run and retry once on a fresh connection."""


def _stall_action(silent_s: float) -> str | None:
    """What the watchdog should do after `silent_s` seconds of run-silence."""
    if silent_s >= config.STALL_CAP_S:
        return "cap"
    if silent_s >= config.STALL_NOTICE_S:
        return "notice"
    return None


def _is_run_activity(payload: dict, run_id) -> bool:
    """Does this gateway event prove OUR run is alive? Own-run frames count;
    so do codex_app_server.* runtime streams (compaction etc. keep emitting
    them mid-turn). Other runs' frames (cron, heartbeat) do NOT."""
    frame_run = payload.get("runId")
    if frame_run is not None and frame_run == run_id:
        return True
    stream = payload.get("stream")
    return isinstance(stream, str) and stream.startswith("codex_app_server")
```

- [ ] **Step 5: Run tests to verify pass**

Run: `python3 -m pytest backend/tests/test_stall_watchdog.py -q`
Expected: 3 passed

- [ ] **Step 6: Commit**

```bash
git add backend/config.py backend/bridge.py backend/tests/test_stall_watchdog.py
git commit -m "feat: stall watchdog primitives + config knobs"
```

---

### Task 2: Watchdog loop in `_relay_events` (+ first-frame/first-text timing)

**Files:**
- Modify: `backend/bridge.py:556-625` (`_relay_events` signature, loop top, delta branch)
- Test: `backend/tests/test_stall_watchdog.py` (append)

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_stall_watchdog.py`:

```python
# --- relay watchdog loop ----------------------------------------------------------

class SilentWS:
    """Replays canned frames, then goes silent forever (stalled gateway)."""

    def __init__(self, frames=()):
        self._frames = [json.dumps(f) for f in frames]

    async def recv(self):
        if self._frames:
            return self._frames.pop(0)
        await asyncio.Event().wait()  # never set — pure silence


def _fast_watchdog(monkeypatch, notice=0.0, cap=0.05):
    monkeypatch.setattr(bridge, "_STALL_TICK_S", 0.01)
    monkeypatch.setattr(config, "STALL_NOTICE_S", notice)
    monkeypatch.setattr(config, "STALL_CAP_S", cap)


def test_silence_emits_stall_frames_then_raises(monkeypatch):
    _fast_watchdog(monkeypatch)

    async def go():
        out = []
        with pytest.raises(bridge._RunStalled):
            async for chunk in bridge._relay_events(SilentWS(), "r1"):
                out.append(json.loads(chunk[5:]))
        return out

    out = asyncio.run(go())
    assert out, "expected stall frames before the cap"
    assert all(f["type"] == "stall" for f in out)
    assert all(isinstance(f["silent_for"], int) for f in out)


def test_normal_turn_unaffected_by_watchdog(monkeypatch):
    _fast_watchdog(monkeypatch, notice=10.0, cap=20.0)

    async def go():
        return [json.loads(c[5:]) for c in
                [x async for x in bridge._relay_events(SilentWS([
                    {"type": "event", "event": "chat",
                     "payload": {"runId": "r1", "deltaText": "hi"}},
                    {"type": "event", "event": "agent",
                     "payload": {"runId": "r1", "stream": "lifecycle",
                                 "data": {"phase": "end"}}},
                ]), "r1")]]

    assert asyncio.run(go()) == [{"delta": "hi"}]


def test_relay_records_first_frame_and_first_text_timing(monkeypatch):
    _fast_watchdog(monkeypatch, notice=10.0, cap=20.0)
    run_info: dict = {}

    async def go():
        async for _ in bridge._relay_events(SilentWS([
            {"type": "event", "event": "chat",
             "payload": {"runId": "r1", "deltaText": "hi"}},
            {"type": "event", "event": "agent",
             "payload": {"runId": "r1", "stream": "lifecycle",
                         "data": {"phase": "end"}}},
        ]), "r1", run_info=run_info):
            pass

    asyncio.run(go())
    timing = run_info["timing"]
    assert "t_first_frame" in timing and "t_first_text" in timing
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest backend/tests/test_stall_watchdog.py -q`
Expected: new tests FAIL (`TypeError: _relay_events() got an unexpected keyword argument 'run_info'` and/or hang-free assertion errors; the two passing-shape frames tests may fail on the missing watchdog)

- [ ] **Step 3: Implement** — in `backend/bridge.py`, `_relay_events`:

(a) Change the signature (line 556) from `async def _relay_events(ws, run_id):` to:

```python
async def _relay_events(ws, run_id, run_info: dict | None = None):
```

(b) Replace the loop top — currently (lines 578-590):

```python
    emitted_len = 0        # fallback cumulative-text cursor
    analysis_seen: dict = {}  # itemId -> reasoning chars already emitted
    tool_since_text = False  # a tool card emitted since the last text delta?
    images_seen: set = set()  # image block urls already emitted (dedupe finals)
    while True:
        frame = await _recv_json(ws)
        if frame.get("type") != "event":
            continue
        event = frame.get("event")
        payload = frame.get("payload") or {}
        frame_run = payload.get("runId")
        if run_id and frame_run is not None and frame_run != run_id:
            continue  # scope strictly to this turn
```

with:

```python
    emitted_len = 0        # fallback cumulative-text cursor
    analysis_seen: dict = {}  # itemId -> reasoning chars already emitted
    tool_since_text = False  # a tool card emitted since the last text delta?
    images_seen: set = set()  # image block urls already emitted (dedupe finals)
    timing = run_info.setdefault("timing", {}) if run_info is not None else {}
    last_activity = time.monotonic()
    while True:
        # Stall watchdog: the gateway WS has pings disabled (a keepalive
        # timeout would kill it mid-turn), so a codex stall used to hang this
        # read — and the user's spinner — forever. Wake every tick, measure
        # run-silence, surface it, and bail past the hard cap. websockets'
        # recv() is cancellation-safe: a timed-out read loses no frame.
        try:
            frame = await asyncio.wait_for(_recv_json(ws), timeout=_STALL_TICK_S)
        except TimeoutError:
            silent = time.monotonic() - last_activity
            action = _stall_action(silent)
            if action == "cap":
                raise _RunStalled(int(silent))
            if action == "notice":
                # Doubles as an SSE keepalive for the Tailscale Serve proxy.
                yield _sse({"type": "stall", "silent_for": int(silent)})
            continue
        if frame.get("type") != "event":
            continue
        event = frame.get("event")
        payload = frame.get("payload") or {}
        if _is_run_activity(payload, run_id):
            timing.setdefault("t_first_frame", time.monotonic())
            last_activity = time.monotonic()
        frame_run = payload.get("runId")
        if run_id and frame_run is not None and frame_run != run_id:
            continue  # scope strictly to this turn
```

(c) In the chat-delta branch — currently (lines 620-624):

```python
            if delta:
                if tool_since_text:
                    yield _sse({"type": "agent_step"})  # open a fresh bubble
                    tool_since_text = False
                yield _sse({"delta": delta})
```

becomes:

```python
            if delta:
                timing.setdefault("t_first_text", time.monotonic())
                if tool_since_text:
                    yield _sse({"type": "agent_step"})  # open a fresh bubble
                    tool_since_text = False
                yield _sse({"delta": delta})
```

(Everything below — analysis/tool/lifecycle branches — is unchanged.)

- [ ] **Step 4: Run the new tests AND the existing relay tests**

Run: `python3 -m pytest backend/tests/test_stall_watchdog.py backend/tests/test_bridge_relay.py -q`
Expected: all pass (the existing `FakeWS` tests never go silent, so the watchdog stays dormant)

- [ ] **Step 5: Commit**

```bash
git add backend/bridge.py backend/tests/test_stall_watchdog.py
git commit -m "feat: stall watchdog loop in the WS relay + first-frame/first-text timing"
```

---

### Task 3: Abort + auto-retry-once in `stream_turn`

**Files:**
- Modify: `backend/bridge.py:219-263` (`stream_turn` relay/cleanup section)
- Test: `backend/tests/test_stall_watchdog.py` (append)

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_stall_watchdog.py`:

```python
# --- stream_turn stall orchestration ----------------------------------------------

class _OpenState:
    name = "OPEN"


class FakeAliveWS:
    state = _OpenState()

    async def close(self):
        pass


def _collect_stream(gen):
    async def go():
        return [json.loads(c[5:]) for c in [x async for x in gen]]
    return asyncio.run(go())


def _wire_stall(monkeypatch, relay_factory):
    opens = []
    aborts = []

    async def fake_open_turn(message, session_key, model_ref, attachments,
                             run_info, allow_warm):
        opens.append(allow_warm)
        run_id = f"r{len(opens)}"
        if run_info is not None:
            run_info["runId"] = run_id
        return FakeAliveWS(), run_id, False

    async def fake_gateway_call(method, params=None, timeout=30.0):
        aborts.append((method, params))
        return {"ok": True, "payload": {}}

    monkeypatch.setattr(bridge, "_open_turn", fake_open_turn)
    monkeypatch.setattr(bridge, "gateway_call", fake_gateway_call)
    monkeypatch.setattr(bridge, "_relay_events", relay_factory)
    return opens, aborts


def test_double_stall_aborts_twice_then_errors(monkeypatch):
    async def always_stall(ws, run_id, run_info=None):
        raise bridge._RunStalled(240)
        yield  # pragma: no cover — makes this an async generator

    run_info: dict = {}
    opens, aborts = _wire_stall(monkeypatch, always_stall)
    out = _collect_stream(bridge.stream_turn("hi", session_key="k",
                                             run_info=run_info))

    assert opens == [True, False]          # retry forced a fresh connection
    assert [m for m, _ in aborts] == ["chat.abort", "chat.abort"]
    assert aborts[0][1] == {"sessionKey": "k", "runId": "r1"}
    assert aborts[1][1] == {"sessionKey": "k", "runId": "r2"}
    assert any(f.get("type") == "stall_retry" for f in out)
    terminal = out[-1]
    assert terminal["type"] == "tool_output" and terminal["exit_code"] == 1
    assert "stalled" in terminal["output"]
    assert run_info["stalled"] is True and run_info["retried"] is True


def test_stall_then_success_recovers(monkeypatch):
    calls = {"n": 0}

    async def stall_once(ws, run_id, run_info=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise bridge._RunStalled(240)
        yield bridge._sse({"delta": "recovered"})

    run_info: dict = {}
    opens, aborts = _wire_stall(monkeypatch, stall_once)
    out = _collect_stream(bridge.stream_turn("hi", session_key="k",
                                             run_info=run_info))

    assert [m for m, _ in aborts] == ["chat.abort"]   # only the zombie killed
    assert {"delta": "recovered"} in out
    assert any(f.get("type") == "stall_retry" for f in out)
    assert not any(f.get("exit_code") == 1 for f in out)
    assert run_info.get("retried") is True


def test_no_stall_no_abort(monkeypatch):
    async def clean(ws, run_id, run_info=None):
        yield bridge._sse({"delta": "hi"})

    opens, aborts = _wire_stall(monkeypatch, clean)
    out = _collect_stream(bridge.stream_turn("hi", session_key="k"))

    assert aborts == []
    assert opens == [True]
    assert {"delta": "hi"} in out
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest backend/tests/test_stall_watchdog.py -q`
Expected: the three new tests FAIL (no retry loop yet; `_RunStalled` propagates or wrong abort counts)

- [ ] **Step 3: Implement** — in `backend/bridge.py`, `stream_turn`: replace the relay/cleanup section — currently (lines 249-263):

```python
        # Relay events for this run until lifecycle end.
        try:
            async for chunk in _relay_events(ws, run_id):
                yield chunk
        finally:
            # A mid-stream death makes the warm socket unusable; drop it so the
            # next turn reconnects. Then keep the socket open ONLY if it's still
            # the live warm one; release the lock; close throwaways.
            if not _ws_alive(ws):
                _invalidate_warm(ws)
            if use_warm:
                _warm.lock.release()
            if ws is not None and _warm.ws is not ws:
                with contextlib.suppress(Exception):
                    await ws.close()
```

with:

```python
        # Relay events for this run until lifecycle end. On a stall (no
        # run-activity for STALL_CAP_S) abort the zombie run and retry ONCE on
        # a guaranteed-fresh connection — with a fresh idempotencyKey
        # (_open_turn mints one per call; reusing the old key would trip the
        # gateway's transcript dedup and silently no-op the retry).
        stalled_attempts = 0
        while True:
            stalled = False
            try:
                async for chunk in _relay_events(ws, run_id, run_info=run_info):
                    yield chunk
            except _RunStalled:
                stalled = True
            finally:
                # A mid-stream death (or a stall — that socket's run is now a
                # zombie) makes the warm socket unusable; drop it so the next
                # turn reconnects. Then keep the socket open ONLY if it's still
                # the live warm one; release the lock; close throwaways.
                if stalled or not _ws_alive(ws):
                    _invalidate_warm(ws)
                if use_warm:
                    _warm.lock.release()
                    use_warm = False
                if ws is not None and _warm.ws is not ws:
                    with contextlib.suppress(Exception):
                        await ws.close()
            if not stalled:
                if run_info is not None:
                    run_info.setdefault("timing", {})["t_end"] = time.monotonic()
                break
            if run_info is not None:
                run_info["stalled"] = True
            # Best-effort kill of the zombie run (the gateway itself may be
            # wedged — never let cleanup failure mask the user-facing path).
            with contextlib.suppress(Exception):
                await gateway_call("chat.abort",
                                   {"sessionKey": session_key, "runId": run_id},
                                   timeout=10)
            stalled_attempts += 1
            if stalled_attempts > 1:
                yield _sse({"type": "tool_output", "tool": "agent",
                            "output": ("🧠 no gateway activity for "
                                       f"{int(config.STALL_CAP_S) // 60}m, retried "
                                       "once — codex looks stalled; try again or "
                                       "check the status dot"),
                            "exit_code": 1})
                break
            if run_info is not None:
                run_info["retried"] = True
            yield _sse({"type": "stall_retry"})
            ws, run_id, use_warm = await _open_turn(
                message, session_key, model_ref, attachments, run_info,
                allow_warm=False)
```

Notes for the implementer:
- `gateway_call` opens its own short-lived authed WS (`bridge.py:400`) — exactly what `app.py:513`'s Stop button uses; do NOT send the abort over the possibly-wedged turn socket.
- The retry `_open_turn` may itself raise transport errors; those propagate to `stream_turn`'s existing outer `except websockets.ConnectionClosed` handler, which already yields the monitor-aware disconnect message. No new handling.
- `use_warm = False` after releasing prevents a double-release if a later iteration's cleanup runs.

- [ ] **Step 4: Run the watchdog suite + existing bridge tests**

Run: `python3 -m pytest backend/tests/test_stall_watchdog.py backend/tests/test_bridge_relay.py backend/tests/test_bridge.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/bridge.py backend/tests/test_stall_watchdog.py
git commit -m "feat: abort stalled runs and auto-retry once on a fresh connection"
```

---

### Task 4: t_send / t_ack timing in `_open_turn`, JSONL writer in app.py

**Files:**
- Modify: `backend/bridge.py:196-205` (`_open_turn` send/ack)
- Modify: `backend/app.py` (imports; new helpers near `_late_reply`; `gen()` finally block at ~375; late-reply timestamp at ~370)
- Test: `backend/tests/test_turn_timing.py` (create)

- [ ] **Step 1: Write the failing tests** — create `backend/tests/test_turn_timing.py`:

```python
"""Per-turn timing telemetry: record shape + JSONL writer rotation."""
import json

from backend import app as app_module
from backend import config


def test_record_computes_ms_deltas_and_flags():
    run_info = {"timing": {"t_send": 1.0, "t_ack": 1.5, "t_first_frame": 2.0,
                           "t_first_text": 3.0, "t_end": 4.0},
                "stalled": False}
    rec = app_module._turn_timing_record(run_info, "agent:main:web-x",
                                         "openai/gpt-5.5",
                                         text_seen=True, failed=False)
    assert rec["ack_ms"] == 500
    assert rec["first_frame_ms"] == 1000
    assert rec["first_text_ms"] == 2000
    assert rec["total_ms"] == 3000
    assert rec["late_ms"] is None
    assert rec["model"] == "openai/gpt-5.5"
    assert rec["stalled"] is False and rec["retried"] is False
    assert rec["text_seen"] is True and rec["failed"] is False


def test_record_tolerates_empty_run_info():
    rec = app_module._turn_timing_record({}, "k", None,
                                         text_seen=False, failed=True)
    assert rec["ack_ms"] is None and rec["total_ms"] is None
    assert rec["model"] == "default"


def test_log_appends_jsonl_and_rotates_at_2mb(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    app_module._log_turn_timing({"a": 1})
    path = tmp_path / "turn_timings.jsonl"
    assert json.loads(path.read_text().strip()) == {"a": 1}

    path.write_text("x" * 2_000_001)
    app_module._log_turn_timing({"b": 2})
    assert (tmp_path / "turn_timings.jsonl.old").exists()
    assert json.loads(path.read_text().strip()) == {"b": 2}
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest backend/tests/test_turn_timing.py -q`
Expected: FAIL — `_turn_timing_record` not defined

- [ ] **Step 3: Implement bridge side** — in `backend/bridge.py` `_open_turn`, the send/ack block — currently (lines 196-205):

```python
        send_id = uuid.uuid4().hex
        await ws.send(json.dumps({"type": "req", "id": send_id,
                                  "method": "chat.send", "params": send_params}))
        ack = await _await_response(ws, send_id)
        if not ack.get("ok"):
            raise _ChatSendRejected(ack)
        run_id = (ack.get("payload") or {}).get("runId")
        if run_info is not None:
            run_info["runId"] = run_id
        return ws, run_id, use_warm
```

becomes:

```python
        send_id = uuid.uuid4().hex
        if run_info is not None:
            run_info.setdefault("timing", {})["t_send"] = time.monotonic()
        await ws.send(json.dumps({"type": "req", "id": send_id,
                                  "method": "chat.send", "params": send_params}))
        ack = await _await_response(ws, send_id)
        if not ack.get("ok"):
            raise _ChatSendRejected(ack)
        if run_info is not None:
            run_info["timing"]["t_ack"] = time.monotonic()
        run_id = (ack.get("payload") or {}).get("runId")
        if run_info is not None:
            run_info["runId"] = run_id
        return ws, run_id, use_warm
```

(On a stall retry `_open_turn` runs again and overwrites `t_send`/`t_ack` — intended: the timings then describe the attempt that produced the outcome, and `stalled`/`retried` flags mark the turn as abnormal.)

- [ ] **Step 4: Implement app side** — in `backend/app.py`:

(a) add `import time` to the stdlib import block (after `import re`, line 17).

(b) add the two helpers directly above `_late_reply` (line ~225):

```python
def _turn_timing_record(run_info: dict, session_key: str, model_ref: str | None,
                        *, text_seen: bool, failed: bool) -> dict:
    """One flat JSONL record describing where this turn's wall-clock went.
    All *_ms fields are measured from chat.send write; None = never happened."""
    timing = run_info.get("timing") or {}

    def ms(a: str, b: str) -> int | None:
        return (int((timing[b] - timing[a]) * 1000)
                if a in timing and b in timing else None)

    return {
        "ts": int(time.time()),
        "session": session_key,
        "model": model_ref or "default",
        "ack_ms": ms("t_send", "t_ack"),
        "first_frame_ms": ms("t_send", "t_first_frame"),
        "first_text_ms": ms("t_send", "t_first_text"),
        "late_ms": ms("t_send", "t_late"),
        "total_ms": ms("t_send", "t_end"),
        "stalled": bool(run_info.get("stalled")),
        "retried": bool(run_info.get("retried")),
        "text_seen": text_seen,
        "failed": failed,
    }


def _log_turn_timing(record: dict) -> None:
    """Append one JSONL line to .data/turn_timings.jsonl. Telemetry must never
    break a turn: every failure is swallowed. Single-generation rotation at
    2MB keeps the file bounded on this disk-starved box."""
    with contextlib.suppress(Exception):
        path = config.DATA_DIR / "turn_timings.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.exists() and path.stat().st_size > 2_000_000:
            path.replace(path.with_name(path.name + ".old"))
        with path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
```

(c) in `gen()`, the late-reply block — currently (lines ~369-374):

```python
            if not text_seen and not failed:
                late = await _late_reply(session_key, brain_message)
                if late:
                    if tools_seen:
                        yield bridge._sse({"type": "agent_step"})  # fresh bubble
                    yield bridge._sse({"delta": late})
```

becomes:

```python
            if not text_seen and not failed:
                late = await _late_reply(session_key, brain_message)
                if late:
                    run_info.setdefault("timing", {})["t_late"] = time.monotonic()
                    if tools_seen:
                        yield bridge._sse({"type": "agent_step"})  # fresh bubble
                    yield bridge._sse({"delta": late})
```

(d) in `gen()`'s `finally` block, directly after `_ACTIVE_RUNS.pop(session_key, None)` (line 376), add:

```python
            _log_turn_timing(_turn_timing_record(
                run_info, session_key, _model_ref(rec),
                text_seen=text_seen, failed=failed))
```

- [ ] **Step 5: Run the tests**

Run: `python3 -m pytest backend/tests/test_turn_timing.py backend/tests/test_stall_watchdog.py -q`
Expected: all pass

- [ ] **Step 6: Commit**

```bash
git add backend/bridge.py backend/app.py backend/tests/test_turn_timing.py
git commit -m "feat: per-turn timing telemetry to .data/turn_timings.jsonl"
```

---

### Task 5: Titler on the cheap model

**Files:**
- Modify: `backend/app.py:167-188` (`_collect_brain_text`, `_generate_ai_title`)
- Test: `backend/tests/test_titles.py` (append)

- [ ] **Step 1: Write the failing test** — append to `backend/tests/test_titles.py`:

```python
def test_titler_runs_on_the_configured_cheap_model(monkeypatch):
    # A throwaway 6-word title must never run as a full gpt-5.5 thinking turn
    # racing the user's real first message (the audit's biggest turn tax).
    import asyncio

    from backend import app as app_module
    from backend import config

    captured = {}

    async def fake_stream_turn(prompt, session_key=None, model_ref=None, **kw):
        captured["model_ref"] = model_ref
        yield 'data: {"delta": "Tiny Title"}\n\n'

    monkeypatch.setattr(app_module.bridge, "stream_turn", fake_stream_turn)
    title = asyncio.run(app_module._generate_ai_title("hello there"))
    assert captured["model_ref"] == config.TITLE_MODEL
    assert title == "Tiny Title"
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest backend/tests/test_titles.py -q`
Expected: new test FAILS — `captured["model_ref"]` is `None`

- [ ] **Step 3: Implement** — in `backend/app.py`:

`_collect_brain_text` (line 167) gains a passthrough param:

```python
async def _collect_brain_text(prompt: str, session_key: str,
                              model_ref: str | None = None) -> str:
    chunks: list[str] = []
    async for sse in bridge.stream_turn(prompt, session_key=session_key,
                                        model_ref=model_ref):
```

(rest of the function unchanged), and `_generate_ai_title` (line 188) pins the cheap model:

```python
    return _sanitize_title(await _collect_brain_text(
        prompt, _TITLE_SESSION_KEY, model_ref=config.TITLE_MODEL))
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest backend/tests/test_titles.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/app.py backend/tests/test_titles.py
git commit -m "perf: auto-titles run on the cheap model, not gpt-5.5"
```

---

### Task 6: Late-reply backoff (first check at 0.3s, not 2s)

**Files:**
- Modify: `backend/app.py:225-239` (`_late_reply`)
- Test: `backend/tests/test_late_reply.py` (append)

- [ ] **Step 1: Write the failing tests** — append to `backend/tests/test_late_reply.py`:

```python
# --- _late_reply backoff schedule -------------------------------------------------

import asyncio

from backend import app as app_module


def test_late_reply_first_check_is_fast(monkeypatch):
    """The reply already exists when this poll starts — a flat 2s first sleep
    was pure added latency on every message-tool turn."""
    delays = []

    async def fake_sleep(s):
        delays.append(s)

    async def fake_fetch_history(session_key):
        return {"history": [
            {"role": "user", "content": "msg"},
            {"role": "assistant", "content": "the reply"},
        ]}

    monkeypatch.setattr(app_module.bridge, "fetch_history", fake_fetch_history)
    out = asyncio.run(app_module._late_reply("k", "msg", _sleep=fake_sleep))
    assert out == "the reply"
    assert delays == [0.3]


def test_late_reply_walks_full_backoff_then_gives_up(monkeypatch):
    delays = []

    async def fake_sleep(s):
        delays.append(s)

    async def fake_fetch_history(session_key):
        return {"history": []}

    monkeypatch.setattr(app_module.bridge, "fetch_history", fake_fetch_history)
    out = asyncio.run(app_module._late_reply("k", "msg", _sleep=fake_sleep))
    assert out is None
    assert delays == list(app_module._LATE_REPLY_SCHEDULE)
    assert abs(sum(delays) - 10.0) < 0.01   # same ~10s ceiling as before
```

- [ ] **Step 2: Run to verify failure**

Run: `python3 -m pytest backend/tests/test_late_reply.py -q`
Expected: new tests FAIL — `_late_reply() got an unexpected keyword argument '_sleep'`

- [ ] **Step 3: Implement** — in `backend/app.py`, replace `_late_reply` (lines 225-239) with:

```python
# First checks fire fast — the reply usually already sits in the transcript
# when this poll starts (it lands seconds *before* we get here on slow turns,
# milliseconds after on fast ones). Tail stays ~10s total like the old
# 5 × 2s schedule.
_LATE_REPLY_SCHEDULE = (0.3, 0.5, 1.0, 2.0, 2.0, 2.0, 2.2)


async def _late_reply(session_key: str, brain_message: str,
                      _sleep=asyncio.sleep) -> str | None:
    """Fetch the reply that the gateway commits to the transcript only AFTER
    the run's lifecycle end (message-tool delivery — see _relay_events docs).
    Polls with fast-start backoff; returns None if nothing lands (genuinely
    textless turn)."""
    for delay_s in _LATE_REPLY_SCHEDULE:
        await _sleep(delay_s)
        try:
            data = await bridge.fetch_history(session_key)
        except Exception:  # noqa: BLE001 - transient WS trouble: keep polling
            continue
        text = reply_after(data.get("history") or [], brain_message)
        if text:
            return text
    return None
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest backend/tests/test_late_reply.py -q`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add backend/app.py backend/tests/test_late_reply.py
git commit -m "perf: late-reply poll starts at 0.3s with backoff (was flat 2s)"
```

---

### Task 7: Frontend — stall captions + turn elapsed timer

**Files:**
- Modify: `frontend-overrides/js/chat.js` (two insertion points: after `spinner.start()` ~line 842; new `else if` branches before the `tool_start` branch ~line 1886)

No JS test infra; verification is syntax check + browser smoke (house rule: no headless Chrome).

- [ ] **Step 1: Add the turn clock + elapsed ticker** — in `chat.js`, directly after `spinner.start();` (line ~842, inside the send flow where `spinner` is created):

```js
      // Turn clock: elapsed mm:ss beside the spinner, and the base for the
      // stall captions below. Self-guarding ticker — clears itself the moment
      // the spinner leaves the DOM (first token, error, abort), so no teardown
      // wiring is needed.
      const _turnStart = Date.now();
      const _fmtElapsed = (ms) => {
        const s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      };
      const _elapsedSpan = document.createElement('span');
      _elapsedSpan.className = 'turn-elapsed';
      _elapsedSpan.style.cssText = 'opacity:.55;margin-left:6px;font-size:.85em';
      if (spinner.element) spinner.element.appendChild(_elapsedSpan);
      const _turnTicker = setInterval(() => {
        if (!spinner || !spinner.element || !spinner.element.isConnected) {
          clearInterval(_turnTicker);
          return;
        }
        _elapsedSpan.textContent = _fmtElapsed(Date.now() - _turnStart);
      }, 1000);
```

- [ ] **Step 2: Add the stall frame handlers** — in the SSE dispatch chain, insert before `} else if (json.type === 'tool_start') {` (line ~1886):

```js
              } else if (json.type === 'stall') {
                // Backend watchdog: no gateway activity for silent_for seconds.
                // Surface it on whichever wait indicator is live right now.
                const _stallLabel = 'Still waiting — no activity for ' +
                  (json.silent_for || 0) + 's (' +
                  _fmtElapsed(Date.now() - _turnStart) + ' total)';
                const _dots = document.querySelector('.agent-thinking-dots');
                if (_dots && _dots._spinner) _dots._spinner.updateMessage(_stallLabel);
                else if (spinner && spinner.element && !accumulated) spinner.updateMessage(_stallLabel);
              } else if (json.type === 'stall_retry') {
                const _retryLabel = 'Stalled — retrying on a fresh connection…';
                const _dots = document.querySelector('.agent-thinking-dots');
                if (_dots && _dots._spinner) _dots._spinner.updateMessage(_retryLabel);
                else if (spinner && spinner.element && !accumulated) spinner.updateMessage(_retryLabel);
              }
```

(Both `spinner` and `accumulated` are in scope throughout the dispatch chain — see their uses at lines ~857 and ~879. `_turnStart`/`_fmtElapsed` from Step 1 are in the same closure.)

- [ ] **Step 3: Syntax check**

Run: `node --input-type=module --check < frontend-overrides/js/chat.js && echo OK`
Expected: `OK`

- [ ] **Step 4: Deploy**

Run: `./scripts/sync-frontend.sh | tail -3`
Expected: sync output ends with a fresh `stamped sw.js CACHE_NAME = gary-<hash>` line (hash changed because chat.js changed).

- [ ] **Step 5: Commit**

```bash
git add frontend-overrides/js/chat.js
git commit -m "feat: stall captions + turn elapsed timer on the pending chat bubble"
```

---

### Task 8: Full suite, backend restart, live smoke

**Files:** none (verification only)

- [ ] **Step 1: Full backend test suite**

Run: `python3 -m pytest backend/tests/ -q`
Expected: everything green (pre-existing failures, if any, must be triaged before deploy — report rather than ignore).

- [ ] **Step 2: Restart the workspace backend** (fast uvicorn restart — NOT the 4-5min gateway; the LaunchAgent's pinned env was already validated by the 2026-06-10 23:38 restart):

```bash
launchctl kickstart -k "gui/$(id -u)/ai.openclaw.workspace"
sleep 3
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8800/api/config
```

Expected: `200`

- [ ] **Step 3: Live smoke (with the user, on the real :8443 origin):**
- Send a chat message → reply streams; elapsed mm:ss ticks beside the spinner until the first token.
- New chat → first reply is NOT delayed by titling; the chat still gets an AI title within a few seconds.
- `tail -2 /Users/admin/openclaw-workspace/.data/turn_timings.jsonl` → one record per turn with plausible `ack_ms`/`first_text_ms`.
- Optional stall-UI rehearsal: `WORKSPACE_STALL_NOTICE=5 WORKSPACE_STALL_CAP=600` in a dev run (`scripts/dev.sh` env) and send a long turn → "Still waiting — no activity for Ns" caption appears, then normal recovery.

- [ ] **Step 4: Report results** — including any pre-existing test failures, smoke anomalies, and the first real timing numbers (they're the baseline for the deferred bootstrap-trim decision).

---

## Self-review notes (done at planning time)

- **Spec coverage:** watchdog tick/notice/cap → Tasks 1-2; abort + retry-once + fresh idempotencyKey → Task 3; frontend captions + elapsed → Task 7; titler → Task 5; late-reply backoff → Task 6; timing JSONL + rotation → Task 4; config knobs → Task 1; deploy/smoke → Task 8. Out-of-scope items (thinking toggle, bootstrap trim) correctly absent.
- **Type consistency:** `_relay_events(ws, run_id, run_info=None)` keyword-only-by-position keeps the existing `test_bridge_relay.py` positional calls working; `run_info["timing"]` keys (`t_send/t_ack/t_first_frame/t_first_text/t_late/t_end`) match between bridge writers and `_turn_timing_record` reader; SSE frame names (`stall`, `silent_for`, `stall_retry`) match between Task 3 and Task 7.
- **Known behavior choices (intended, not bugs):** retry overwrites `t_send`/`t_ack`; stall frames don't set `failed=True` in `gen()` (they're not `tool_output` error frames); `TimeoutError` is the builtin (== `asyncio.TimeoutError` on 3.11+).
