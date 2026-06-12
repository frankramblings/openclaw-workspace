"""Per-chat speed setting: store round-trip, PATCH validation."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config, sessions_store
from backend.app import app


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    """Redirect the store's file path and config.DATA_DIR to tmp_path so
    tests never touch the real sessions.json. _STORE_FILE is a module-level
    constant so we monkeypatch it directly on the module."""
    data_dir = tmp_path / "data"
    data_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(sessions_store, "_STORE_FILE", data_dir / "sessions.json")
    monkeypatch.setattr(config, "DATA_DIR", data_dir)


# ---------------------------------------------------------------------------
# Store-level tests
# ---------------------------------------------------------------------------

def test_create_defaults_speed_normal():
    rec = sessions_store.create(name="t")
    assert rec["speed"] == "normal"


def test_update_round_trips_speed():
    rec = sessions_store.create(name="t")
    sessions_store.update(rec["id"], speed="fast")
    assert sessions_store.get(rec["id"])["speed"] == "fast"


def test_old_records_without_speed_read_as_normal():
    rec = sessions_store.create(name="t")
    rec.pop("speed", None)  # simulate a pre-speed record
    assert (rec.get("speed") or "normal") == "normal"


# ---------------------------------------------------------------------------
# Endpoint tests — FastAPI TestClient (matching test_chat_stream_draft style)
# ---------------------------------------------------------------------------

def test_patch_speed_valid_persists():
    """PATCH speed=deep should be stored on the session record."""
    rec = sessions_store.create(name="patch-test")
    sid = rec["id"]
    client = TestClient(app)
    resp = client.patch(f"/api/session/{sid}", data={"speed": "deep"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["speed"] == "deep"


def test_patch_speed_invalid_ignored():
    """PATCH speed=warp (invalid) must leave the previous value unchanged."""
    rec = sessions_store.create(name="patch-bad")
    sid = rec["id"]
    # First set a known good value
    sessions_store.update(sid, speed="deep")
    client = TestClient(app)
    resp = client.patch(f"/api/session/{sid}", data={"speed": "warp"})
    assert resp.status_code == 200
    assert sessions_store.get(sid)["speed"] == "deep"


# --- thinking pass-through (bridge) ------------------------------------------------

import asyncio
import json

from backend import bridge


def _run_open_turn(monkeypatch, **kwargs):
    sent = {}

    class WS:
        async def send(self, raw):
            sent.update(json.loads(raw))

    async def fake_connect():
        return WS()

    async def fake_await_response(ws, req_id):
        return {"ok": True, "payload": {"runId": "r1"}}

    monkeypatch.setattr(bridge, "_connect_and_auth", fake_connect)
    monkeypatch.setattr(bridge, "_await_response", fake_await_response)

    async def go():
        ws, run_id, use_warm = await bridge._open_turn(
            "hi", "k", None, None, None, allow_warm=False, **kwargs)
        # _open_turn may promote the fresh socket to the warm slot and hold
        # the lock — release so tests stay leak-free (see warm-lock tests).
        if use_warm:
            bridge._warm.lock.release()
        bridge._warm.ws = None
        bridge._pinned.clear()

    asyncio.run(go())
    return sent


def test_open_turn_includes_thinking_when_set(monkeypatch):
    sent = _run_open_turn(monkeypatch, thinking="low")
    assert sent["params"]["thinking"] == "low"


def test_open_turn_omits_thinking_by_default(monkeypatch):
    sent = _run_open_turn(monkeypatch)
    assert "thinking" not in sent["params"]


def test_stall_retry_preserves_thinking(monkeypatch):
    seen_thinking = []

    async def fake_open_turn(message, session_key, model_ref, attachments,
                             run_info, allow_warm, thinking=None):
        seen_thinking.append(thinking)
        run_id = f"r{len(seen_thinking)}"
        if run_info is not None:
            run_info["runId"] = run_id

        class _S:
            name = "OPEN"

        class _WS:
            state = _S()

            async def close(self):
                pass

        return _WS(), run_id, False

    calls = {"n": 0}

    async def stall_once(ws, run_id, run_info=None):
        calls["n"] += 1
        if calls["n"] == 1:
            raise bridge._RunStalled(240)
        yield bridge._sse({"delta": "ok"})

    async def fake_gateway_call(method, params=None, timeout=30.0):
        return {"ok": True, "payload": {}}

    monkeypatch.setattr(bridge, "_open_turn", fake_open_turn)
    monkeypatch.setattr(bridge, "gateway_call", fake_gateway_call)
    monkeypatch.setattr(bridge, "_relay_events", stall_once)

    async def go():
        return [c async for c in bridge.stream_turn("hi", session_key="k",
                                                    thinking="low")]

    asyncio.run(go())
    assert seen_thinking == ["low", "low"]
