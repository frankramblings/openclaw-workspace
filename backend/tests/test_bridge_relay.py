"""Unit tests for _relay_events' gateway-event → SSE mapping, driven by a fake
WS that replays canned frames (the real shapes, verified against the OpenClaw
source — see the control-ui-borrowings spec)."""
import asyncio
import json

from backend.bridge import _relay_events


class FakeWS:
    def __init__(self, frames):
        self._frames = [json.dumps(f) for f in frames]

    async def recv(self):
        if not self._frames:
            raise AssertionError("relay read past the last frame")
        return self._frames.pop(0)


def collect(frames, run_id="r1"):
    async def go():
        return [json.loads(c[5:]) for c in
                [x async for x in _relay_events(FakeWS(frames), run_id)]]
    return asyncio.run(go())


def test_delta_passthrough_and_lifecycle_end():
    out = collect([
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "deltaText": "hi"}},
        {"type": "event", "event": "agent",
         "payload": {"runId": "r1", "stream": "lifecycle", "data": {"phase": "end"}}},
    ])
    assert {"delta": "hi"} in out
    assert out[0] == {"type": "run_alive"}
    assert not any(f.get("type") == "stall" for f in out)


def test_aborted_state_maps_to_stopped_card():
    out = collect([
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "state": "aborted"}},
    ])
    # run_alive precedes the aborted card (same frame triggers activity + abort)
    tool_cards = [f for f in out if f.get("type") == "tool_output"]
    assert len(tool_cards) == 1
    assert tool_cards[0]["exit_code"] == 0
    assert "stopped" in tool_cards[0]["output"]


def test_disconnect_message_reflects_monitor_state():
    from backend.bridge import _disconnect_message
    assert "restarting" in _disconnect_message("restarting")
    assert "restarting" not in _disconnect_message("down")
    assert "may not have completed" in _disconnect_message("down")


def test_analysis_items_map_to_thinking_deltas_with_cumulative_diff():
    def item(phase, **fields):
        return {"type": "event", "event": "agent",
                "payload": {"runId": "r1", "stream": "item",
                            "data": {"itemId": "a1", "kind": "analysis",
                                     "phase": phase, **fields}}}
    out = collect([
        item("start"),
        item("update", text="Let me think"),
        item("update", text="Let me think harder"),  # cumulative → diff
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "deltaText": "391"}},
        {"type": "event", "event": "agent",
         "payload": {"runId": "r1", "stream": "lifecycle",
                     "data": {"phase": "end"}}},
    ])
    thinking = [c for c in out if c.get("thinking")]
    assert [c["delta"] for c in thinking] == ["Let me think", " harder"]
    assert out[-1] == {"delta": "391"}


def test_analysis_delta_field_passes_through_incremental():
    from backend.bridge import _analysis_delta
    seen = {}
    assert _analysis_delta({"itemId": "a1", "delta": "abc"}, seen) == "abc"
    assert _analysis_delta({"itemId": "a1", "delta": "def"}, seen) == "def"


def test_analysis_delta_ignores_empty_and_repeat():
    from backend.bridge import _analysis_delta
    seen = {}
    assert _analysis_delta({"itemId": "a1", "text": "abc"}, seen) == "abc"
    assert _analysis_delta({"itemId": "a1", "text": "abc"}, seen) == ""
    assert _analysis_delta({"itemId": "a1"}, seen) == ""


def test_textless_analysis_frames_emit_nothing():
    # The live v4 shape (probed 2026-06-07): analysis items carry only
    # {title: "Reasoning", status} — title is a static label, never content.
    def item(phase, **fields):
        return {"type": "event", "event": "agent",
                "payload": {"runId": "r1", "stream": "item",
                            "data": {"itemId": "a1", "kind": "analysis",
                                     "phase": phase, **fields}}}
    out = collect([
        item("start", title="Reasoning", status="running"),
        item("end", title="Reasoning", status="completed"),
        {"type": "event", "event": "agent",
         "payload": {"runId": "r1", "stream": "lifecycle",
                     "data": {"phase": "end"}}},
    ])
    # run_alive fires on the first own-run frame; no text/thinking deltas expected
    assert out == [{"type": "run_alive"}]
