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
