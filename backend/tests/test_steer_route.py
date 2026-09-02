import json

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, event_store, sessions_store, steer
from backend.app import app


class _Live:
    def done(self):
        return False


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def cli_session():
    rec = sessions_store.create(name="s", model="claude-opus-4-8", endpoint_id="claude-cli")
    yield rec
    sessions_store.delete(rec["id"])


@pytest.fixture
def steerable(monkeypatch):
    monkeypatch.setattr(steer, "patch_present", lambda dist_dir=None: True)


def _frames(session_key):
    return [json.loads(p[6:].strip()) for _, p in event_store.since(session_key, None)
            if p.startswith("data: {")]


def test_409_when_no_turn_active(client, cli_session, steerable, monkeypatch):
    monkeypatch.setattr(app_module, "_TURN_TASKS", {})
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "hi"})
    assert r.status_code == 409
    assert r.json()["reason"] == "no_active_turn"


def test_409_when_session_is_not_claude_cli(client, steerable, monkeypatch):
    rec = sessions_store.create(name="s", model="gpt-5.5", endpoint_id="openai")
    monkeypatch.setattr(app_module, "_TURN_TASKS", {rec["sessionKey"]: _Live()})
    r = client.post(f"/api/chat/steer/{rec['id']}", data={"message": "hi"})
    assert r.status_code == 409
    assert r.json()["reason"] == "steer_unavailable"


def test_409_when_patch_missing(client, cli_session, monkeypatch):
    monkeypatch.setattr(steer, "patch_present", lambda dist_dir=None: False)
    monkeypatch.setattr(app_module, "_TURN_TASKS", {cli_session["sessionKey"]: _Live()})
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "hi"})
    assert r.status_code == 409
    assert r.json()["reason"] == "steer_unavailable"


def test_400_on_empty_message(client, cli_session, steerable, monkeypatch):
    monkeypatch.setattr(app_module, "_TURN_TASKS", {cli_session["sessionKey"]: _Live()})
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "   "})
    assert r.status_code == 400


def test_success_sends_and_appends_frame(client, cli_session, steerable, monkeypatch):
    sk = cli_session["sessionKey"]
    monkeypatch.setattr(app_module, "_TURN_TASKS", {sk: _Live()})
    sent = {}

    async def fake_steer(session_key, message):
        sent["key"], sent["msg"] = session_key, message
        return {"runId": "run-77", "status": "started"}

    monkeypatch.setattr(bridge, "steer_turn", fake_steer)
    event_store.drop_session(sk)
    r = client.post(f"/api/chat/steer/{cli_session['id']}",
                    data={"message": "use the smaller patch", "client_id": "live-u-42"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "steered": True, "runId": "run-77"}
    assert sent == {"key": sk, "msg": "use the smaller patch"}
    frames = _frames(sk)
    assert len(frames) == 1
    f = frames[0]
    assert f["type"] == "user_steer" and f["text"] == "use the smaller patch"
    assert f["client_id"] == "live-u-42" and isinstance(f["ts"], int)


def test_502_when_gateway_rejects_and_no_frame(client, cli_session, steerable, monkeypatch):
    sk = cli_session["sessionKey"]
    monkeypatch.setattr(app_module, "_TURN_TASKS", {sk: _Live()})

    async def boom(session_key, message):
        raise RuntimeError("chat.send failed")

    monkeypatch.setattr(bridge, "steer_turn", boom)
    event_store.drop_session(sk)
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "x"})
    assert r.status_code == 502
    assert r.json()["reason"] == "gateway_error"
    assert _frames(sk) == []
