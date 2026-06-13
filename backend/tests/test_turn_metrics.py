"""The /api/chat_stream relay ends successful turns with a {type:"metrics"}
frame (response_time + pre-text wait) that chatRenderer.displayMetrics turns
into the message-footer time. Failed turns and turns whose bridge never
acked (no t_send) must NOT emit one."""
import json
import time

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, config
from backend.app import app


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Keep test turns out of the real .data/turn_timings.jsonl."""
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


@pytest.fixture(autouse=True)
def _no_auto_extract(monkeypatch):
    async def fake_extract(session_key):
        return None
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)


def _events(sse_text: str) -> list:
    out = []
    for line in sse_text.splitlines():
        if line.startswith("data: "):
            try:
                out.append(json.loads(line[6:]))
            except ValueError:
                out.append(line[6:])  # the [DONE] marker
    return out


def _metrics(events):
    return [e for e in events if isinstance(e, dict) and e.get("type") == "metrics"]


def test_successful_turn_emits_metrics_frame(monkeypatch):
    async def fake_stream_turn(message, session_key=None, model_ref=None,
                               run_info=None, **kwargs):
        now = time.monotonic()
        run_info["timing"] = {"t_send": now - 2.0, "t_first_text": now - 0.5,
                              "t_end": now}
        yield bridge._sse({"delta": "hi"})

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    res = TestClient(app).post("/api/chat_stream",
                               data={"message": "hello", "session": ""})
    assert res.status_code == 200
    events = _events(res.text)

    frames = _metrics(events)
    assert len(frames) == 1
    data = frames[0]["data"]
    assert data["response_time"] == pytest.approx(2.0, abs=0.3)
    assert data["agent_model_wait_time"] == pytest.approx(1.5, abs=0.3)
    # metrics precede the final [DONE]
    assert events.index(frames[0]) < len(events) - 1
    assert events[-1] == "[DONE]"


def test_failed_turn_emits_no_metrics(monkeypatch):
    async def fake_stream_turn(message, session_key=None, model_ref=None,
                               run_info=None, **kwargs):
        run_info["timing"] = {"t_send": time.monotonic()}
        yield bridge._sse({"type": "tool_output", "tool": "bridge",
                           "tool_id": "boom", "output": "exploded",
                           "exit_code": 1})

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    res = TestClient(app).post("/api/chat_stream",
                               data={"message": "hello", "session": ""})
    assert _metrics(_events(res.text)) == []


def test_unacked_turn_emits_no_metrics(monkeypatch):
    """No t_send (bridge never acked the send) → nothing to measure."""
    async def fake_stream_turn(message, session_key=None, model_ref=None,
                               run_info=None, **kwargs):
        yield bridge._sse({"delta": "hi"})

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    res = TestClient(app).post("/api/chat_stream",
                               data={"message": "hello", "session": ""})
    assert _metrics(_events(res.text)) == []
