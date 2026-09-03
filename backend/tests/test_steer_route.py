import json

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, event_store, sessions_store, steer
from backend.app import app


class _Live:
    def done(self):
        return False


class _Done:
    def done(self):
        return True


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


def test_success_marks_opened(client, cli_session, steerable, monkeypatch):
    # M9: a send routed through the steer endpoint is still a user send —
    # spec 5 says every one stamps `opened`, or a thread closed from the
    # shelf and then steered would drop off OPEN when the turn ends.
    sk = cli_session["sessionKey"]
    monkeypatch.setattr(app_module, "_TURN_TASKS", {sk: _Live()})

    async def fake_steer(session_key, message):
        return {"runId": "run-1"}

    monkeypatch.setattr(bridge, "steer_turn", fake_steer)
    event_store.drop_session(sk)
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "steer this"})
    assert r.status_code == 200
    opened = sessions_store.get(cli_session["id"])["opened"]
    assert isinstance(opened, int) and opened > 0


def test_steer_store_failure_never_breaks_the_steer(client, cli_session, steerable,
                                                     monkeypatch, caplog):
    # The same swallow-and-warn convention chat_stream uses for mark_opened:
    # a sessions_store failure must not turn a successful steer into an error.
    import logging

    sk = cli_session["sessionKey"]
    monkeypatch.setattr(app_module, "_TURN_TASKS", {sk: _Live()})

    async def fake_steer(session_key, message):
        return {"runId": "run-1"}

    def _boom(*a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr(bridge, "steer_turn", fake_steer)
    monkeypatch.setattr(sessions_store, "mark_opened", _boom)
    event_store.drop_session(sk)
    with caplog.at_level(logging.WARNING, logger="backend.app"):
        r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "steer this"})
    assert r.status_code == 200
    assert r.json()["steered"] is True
    assert any(
        rec.name == "backend.app" and rec.levelno == logging.WARNING
        and rec.exc_info is not None
        for rec in caplog.records
    )


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


def test_409_when_task_present_but_already_finished(client, cli_session, steerable,
                                                    monkeypatch):
    # The task slot is only cleared after the recorder closes the turn, so a
    # finished-but-not-yet-reaped task must read as "no active turn", not as a
    # steerable one (the client then just sends normally).
    monkeypatch.setattr(app_module, "_TURN_TASKS", {cli_session["sessionKey"]: _Done()})
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "hi"})
    assert r.status_code == 409
    assert r.json()["reason"] == "no_active_turn"


def test_nul_only_message_is_empty_not_steered(client, cli_session, steerable,
                                               monkeypatch):
    monkeypatch.setattr(app_module, "_TURN_TASKS", {cli_session["sessionKey"]: _Live()})
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={"message": "\x00 \x00"})
    assert r.status_code == 400
    assert r.json()["reason"] == "empty_message"


def test_text_nul_stripped_and_client_id_sanitized(client, cli_session, steerable,
                                                   monkeypatch):
    sk = cli_session["sessionKey"]
    monkeypatch.setattr(app_module, "_TURN_TASKS", {sk: _Live()})
    sent = {}

    async def fake_steer(session_key, message):
        sent["msg"] = message
        return {"runId": "r1"}

    monkeypatch.setattr(bridge, "steer_turn", fake_steer)
    event_store.drop_session(sk)
    r = client.post(f"/api/chat/steer/{cli_session['id']}", data={
        "message": "use\x0042", "client_id": "live-u_9<script>é" + "z" * 80})
    assert r.status_code == 200
    assert sent["msg"] == "use42"
    frame = _frames(sk)[0]
    assert frame["text"] == "use42"
    assert frame["client_id"] == ("live-u_9scriptz" + "z" * 79)[:64]
    assert len(frame["client_id"]) == 64


def test_client_id_of_only_junk_becomes_empty(client, cli_session, steerable,
                                              monkeypatch):
    sk = cli_session["sessionKey"]
    monkeypatch.setattr(app_module, "_TURN_TASKS", {sk: _Live()})

    async def fake_steer(session_key, message):
        return {"runId": "r1"}

    monkeypatch.setattr(bridge, "steer_turn", fake_steer)
    event_store.drop_session(sk)
    r = client.post(f"/api/chat/steer/{cli_session['id']}",
                    data={"message": "hi", "client_id": "<<>>!!"})
    assert r.status_code == 200
    assert _frames(sk)[0]["client_id"] == ""
