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

    out = asyncio.run(go())
    assert {"delta": "hi"} in out
    assert not any(f.get("type") == "stall" for f in out)


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


def test_unrelated_traffic_cannot_starve_stall_detection(monkeypatch):
    """Other runs' frames keep the socket busy (recv never times out), but our
    run is silent — the watchdog must still trip the cap."""
    _fast_watchdog(monkeypatch, notice=0.0, cap=0.03)

    class ChattyWS:
        async def recv(self):
            await asyncio.sleep(0.005)   # always faster than the tick
            return json.dumps({"type": "event", "event": "agent",
                               "payload": {"runId": "OTHER",
                                           "stream": "lifecycle",
                                           "data": {"phase": "end"}}})

    async def go():
        with pytest.raises(bridge._RunStalled):
            async for _ in bridge._relay_events(ChattyWS(), "r1"):
                pass

    asyncio.run(go())


# --- stream_turn stall orchestration ----------------------------------------------

class _OpenState:
    name = "OPEN"


class FakeAliveWS:
    state = _OpenState()

    async def close(self):
        pass


def _collect_stream(gen):
    async def go():
        out = []
        async for c in gen:
            try:
                out.append(json.loads(c[5:]))
            except json.JSONDecodeError:
                pass  # skip sentinel frames like [DONE]
        return out
    return asyncio.run(go())


def _wire_stall(monkeypatch, relay_factory):
    opens = []
    aborts = []

    async def fake_open_turn(message, session_key, model_ref, attachments,
                             run_info, allow_warm, thinking=None):
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
    assert "t_end" in run_info["timing"]


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


def test_warm_lock_released_when_retry_holds_it(monkeypatch):
    """The retry _open_turn can legitimately promote its fresh socket to the
    warm slot and hand back use_warm=True (allow_warm=False only skips REUSE,
    not promotion). If that retry then stalls too, the per-iteration cleanup
    must still release the warm lock — a leak here would silently force fresh
    connect+auth on every later turn."""
    opens = []
    aborts = []

    async def fake_open_turn(message, session_key, model_ref, attachments,
                             run_info, allow_warm, thinking=None):
        opens.append(allow_warm)
        run_id = f"r{len(opens)}"
        if run_info is not None:
            run_info["runId"] = run_id
        if len(opens) == 2:           # retry: promote to warm slot like the real code
            await bridge._warm.lock.acquire()
            bridge._warm.ws = FakeAliveWS()
            return bridge._warm.ws, run_id, True
        return FakeAliveWS(), run_id, False

    async def fake_gateway_call(method, params=None, timeout=30.0):
        aborts.append((method, params))
        return {"ok": True, "payload": {}}

    async def always_stall(ws, run_id, run_info=None):
        raise bridge._RunStalled(240)
        yield  # pragma: no cover

    monkeypatch.setattr(bridge, "_open_turn", fake_open_turn)
    monkeypatch.setattr(bridge, "gateway_call", fake_gateway_call)
    monkeypatch.setattr(bridge, "_relay_events", always_stall)

    out = _collect_stream(bridge.stream_turn("hi", session_key="k"))

    assert len(aborts) == 2
    assert not bridge._warm.lock.locked(), "warm lock leaked by retry cleanup"
    assert bridge._warm.ws is None, "stalled warm socket not invalidated"
    assert out[-1]["exit_code"] == 1


def test_retry_after_streamed_text_opens_fresh_bubble_and_resets_first_stamps(monkeypatch):
    calls = {"n": 0}

    async def stall_after_text(ws, run_id, run_info=None):
        calls["n"] += 1
        if calls["n"] == 1:
            if run_info is not None:
                run_info.setdefault("timing", {})["t_first_text"] = 1.0
                run_info["timing"]["t_first_frame"] = 0.5
            yield bridge._sse({"delta": "partial"})
            raise bridge._RunStalled(240)
        yield bridge._sse({"delta": "full reply"})

    run_info: dict = {}
    opens, aborts = _wire_stall(monkeypatch, stall_after_text)
    out = _collect_stream(bridge.stream_turn("hi", session_key="k",
                                             run_info=run_info))

    retry_idx = next(i for i, f in enumerate(out) if f.get("type") == "stall_retry")
    assert out[retry_idx + 1] == {"type": "agent_step"}   # fresh bubble
    # attempt-1 stamps dropped so retry deltas can't go negative (the fake
    # attempt-2 relay sets none, so both keys must be gone entirely)
    assert "t_first_frame" not in run_info["timing"]
    assert "t_first_text" not in run_info["timing"]


def test_terminal_stall_card_carries_stall_tool_id(monkeypatch):
    async def always_stall(ws, run_id, run_info=None):
        raise bridge._RunStalled(240)
        yield  # pragma: no cover

    opens, aborts = _wire_stall(monkeypatch, always_stall)
    out = _collect_stream(bridge.stream_turn("hi", session_key="k"))
    terminal = out[-1]
    assert terminal["exit_code"] == 1 and terminal["tool_id"] == "stall"


# --- run_alive frame ---------------------------------------------------------------

def test_run_alive_emitted_once_before_first_delta(monkeypatch):
    _fast_watchdog(monkeypatch, notice=10.0, cap=20.0)

    async def go():
        return [json.loads(c[5:]) for c in
                [x async for x in bridge._relay_events(SilentWS([
                    {"type": "event", "event": "chat",
                     "payload": {"runId": "r1", "deltaText": "a"}},
                    {"type": "event", "event": "chat",
                     "payload": {"runId": "r1", "deltaText": "b"}},
                    {"type": "event", "event": "agent",
                     "payload": {"runId": "r1", "stream": "lifecycle",
                                 "data": {"phase": "end"}}},
                ]), "r1")]]

    out = asyncio.run(go())
    assert out[0] == {"type": "run_alive"}
    assert [f for f in out if f.get("type") == "run_alive"] == [{"type": "run_alive"}]
    assert {"delta": "a"} in out and {"delta": "b"} in out


def test_no_run_alive_without_activity(monkeypatch):
    # Other runs' frames are not OUR activity — no run_alive for them.
    _fast_watchdog(monkeypatch, notice=10.0, cap=0.05)

    async def go():
        out = []
        with pytest.raises(bridge._RunStalled):
            async for c in bridge._relay_events(SilentWS([
                {"type": "event", "event": "chat",
                 "payload": {"runId": "OTHER", "deltaText": "x"}},
            ]), "r1"):
                out.append(json.loads(c[5:]))
        return out

    out = asyncio.run(go())
    assert not any(f.get("type") == "run_alive" for f in out)
