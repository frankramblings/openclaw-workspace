"""/api/chat/turn is the client's single source of truth for 'is this turn
alive?'. It must carry the durable turn_id while active, and an honest
last_turn: interrupted marker after a boot sweep — that's what lets the SPA
replace a frozen 'Working…' with a truthful post-mortem after a restart."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config, event_store, turn_state


@pytest.fixture
def client():
    return TestClient(app_module.app)


def test_active_snapshot_carries_turn_id(client):
    key = config.web_session_key()
    tid = turn_state.turn_started(key)
    event_store.begin_turn(key)
    try:
        body = client.get("/api/chat/turn").json()
        assert body["active"] is True
        assert body["turn_id"] == tid
    finally:
        event_store.end_turn(key)
        turn_state.turn_ended(key)


def test_interrupted_last_turn_after_boot_sweep(client):
    key = config.web_session_key()
    tid = turn_state.turn_started(key)
    turn_state.sweep_boot()  # what app._lifespan does at startup
    body = client.get("/api/chat/turn").json()
    assert body["active"] is False
    assert body["last_turn"] == {"turn_id": tid, "status": "interrupted"}


def test_clean_idle_snapshot_has_no_last_turn(client):
    body = client.get("/api/chat/turn").json()
    assert body["active"] is False
    assert "last_turn" not in body
