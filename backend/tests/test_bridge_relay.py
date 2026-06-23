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


def test_final_snapshot_does_not_re_emit_streamed_text():
    # claude-cli (and any model that ends with a state:"final" snapshot) streams
    # deltaText increments, then sends a final frame carrying the WHOLE message
    # with no deltaText. The relay must NOT re-emit the already-streamed text —
    # that doubled the reply on screen ("Hi thereHi there"). Regression guard.
    out = collect([
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "delta", "deltaText": "Hi",
            "message": {"content": [{"text": "Hi"}]}}},
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "delta", "deltaText": " there",
            "message": {"content": [{"text": "Hi there"}]}}},
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "final",
            "message": {"content": [{"text": "Hi there"}]}}},
        {"type": "event", "event": "agent", "payload": {
            "runId": "r1", "stream": "lifecycle", "data": {"phase": "end"}}},
    ])
    deltas = "".join(f["delta"] for f in out if "delta" in f)
    assert deltas == "Hi there"  # not the doubled "Hi thereHi there"


def test_message_tool_delivery_is_dropped_for_final_reply():
    # The agent emits its `message`-tool delivery ("Sent.") and THEN its real
    # reply ("Hi there"); the gateway resets message.content between them. The
    # relay must emit a reply_reset so the SPA drops the delivery and shows only
    # the final reply — not "Sent.Hi there".
    out = collect([
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "delta", "deltaText": "Sent.",
            "message": {"content": [{"text": "Sent."}]}}},
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "delta", "deltaText": "Hi there",
            "message": {"content": [{"text": "Hi there"}]}}},  # content RESET
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "final",
            "message": {"content": [{"text": "Hi there"}]}}},
        {"type": "event", "event": "agent", "payload": {
            "runId": "r1", "stream": "lifecycle", "data": {"phase": "end"}}},
    ])
    assert any(f.get("type") == "reply_reset" for f in out)
    # the SPA clears on reply_reset, so the deltas after the last reset are the reply
    last_reset = max(i for i, f in enumerate(out) if f.get("type") == "reply_reset")
    after = "".join(f["delta"] for f in out[last_reset:] if "delta" in f)
    assert after == "Hi there"


def test_final_snapshot_emits_text_when_no_deltas_streamed():
    # The cumulative fallback must still work when a turn sends ONLY a final
    # snapshot (no deltaText at all) — e.g. a non-streaming model.
    out = collect([
        {"type": "event", "event": "chat", "payload": {
            "runId": "r1", "state": "final",
            "message": {"content": [{"text": "All done."}]}}},
        {"type": "event", "event": "agent", "payload": {
            "runId": "r1", "stream": "lifecycle", "data": {"phase": "end"}}},
    ])
    deltas = "".join(f["delta"] for f in out if "delta" in f)
    assert deltas == "All done."


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
