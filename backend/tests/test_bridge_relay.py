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
    assert out == [{"delta": "hi"}]


def test_aborted_state_maps_to_stopped_card():
    out = collect([
        {"type": "event", "event": "chat",
         "payload": {"runId": "r1", "state": "aborted"}},
    ])
    assert len(out) == 1
    assert out[0]["type"] == "tool_output"
    assert out[0]["exit_code"] == 0
    assert "stopped" in out[0]["output"]
