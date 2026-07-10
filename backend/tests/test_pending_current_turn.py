"""Tests for GET /api/pending/current-turn — the turn-id helper consumed by
the gateway image_generate hook at spawn time."""
from fastapi.testclient import TestClient

from backend.app import app
from backend import event_store, pending_tokens


def test_current_turn_unknown_session_is_404():
    client = TestClient(app)
    r = client.get("/api/pending/current-turn", params={"session": "definitely-not-a-session"})
    assert r.status_code == 404


def test_current_turn_no_active_turn_returns_null(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    sk = "agent:main:web-testct"
    event_store.drop_session(sk)
    client = TestClient(app)
    # session_key with ':' is accepted directly by _resolve_session_key
    r = client.get("/api/pending/current-turn", params={"session": sk})
    assert r.status_code == 200
    body = r.json()
    assert body["turn_id"] is None
    assert body["active"] is False


def test_current_turn_active_turn_returns_seq(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    sk = "agent:main:web-testct2"
    event_store.drop_session(sk)
    event_store.begin_turn(sk)
    # turn_start_id is only returned once at least one event is buffered
    event_store.append(sk, 'data: {"delta":"hi"}\n\n')
    client = TestClient(app)
    r = client.get("/api/pending/current-turn", params={"session": sk})
    assert r.status_code == 200
    body = r.json()
    assert isinstance(body["turn_id"], int)
    assert body["turn_id"] >= 1
    assert body["active"] is True
    event_store.end_turn(sk)
    event_store.drop_session(sk)


def test_current_turn_ended_turn_not_active(monkeypatch, tmp_path):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    sk = "agent:main:web-testct3"
    event_store.drop_session(sk)
    event_store.begin_turn(sk)
    event_store.append(sk, 'data: {"delta":"hi"}\n\n')
    event_store.end_turn(sk)
    client = TestClient(app)
    r = client.get("/api/pending/current-turn", params={"session": sk})
    assert r.status_code == 200
    body = r.json()
    assert body["active"] is False
    # turn_id retained after end_turn (late reloads can still replay the turn)
    assert isinstance(body["turn_id"], int)
    event_store.drop_session(sk)
