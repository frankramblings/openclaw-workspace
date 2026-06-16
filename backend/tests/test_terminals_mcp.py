"""Gary-drive (PR2 Task 1): per-turn token map, Gary-mode resolution, and the
loopback MCP-facing terminal endpoints."""
import time

from fastapi.testclient import TestClient

from backend import sessions_store, terminals
from backend.app import app


# --- token mint/resolve -----------------------------------------------------

def test_token_mint_resolve_roundtrip():
    token = terminals.mint_terminal_token("sess-A")
    assert terminals.resolve_terminal_token(token) == "sess-A"


def test_resolve_unknown_token_is_none():
    assert terminals.resolve_terminal_token("nope") is None


def test_expired_token_resolves_to_none(monkeypatch):
    monkeypatch.setattr(terminals, "TERMINAL_TOKEN_TTL", 0.0)
    token = terminals.mint_terminal_token("sess-expire")
    # TTL 0 => exp == now, and _prune drops entries where exp <= now.
    time.sleep(0.01)
    assert terminals.resolve_terminal_token(token) is None


# --- gary-mode resolution ---------------------------------------------------

def test_gary_mode_uses_global_default_when_override_none(monkeypatch):
    monkeypatch.setattr(sessions_store, "gary_terminal_override", lambda k: None)
    monkeypatch.setattr(terminals, "gary_mode_default", lambda: True)
    assert terminals.gary_mode_for_session("k") is True
    monkeypatch.setattr(terminals, "gary_mode_default", lambda: False)
    assert terminals.gary_mode_for_session("k") is False


def test_gary_mode_uses_override_when_bool(monkeypatch):
    monkeypatch.setattr(sessions_store, "gary_terminal_override", lambda k: True)
    monkeypatch.setattr(terminals, "gary_mode_default", lambda: False)
    assert terminals.gary_mode_for_session("k") is True
    monkeypatch.setattr(sessions_store, "gary_terminal_override", lambda k: False)
    monkeypatch.setattr(terminals, "gary_mode_default", lambda: True)
    assert terminals.gary_mode_for_session("k") is False


# --- sessions_store helpers -------------------------------------------------

def test_sessions_store_gary_terminal_default_none_and_override():
    rec = sessions_store.create(name="gary-test")
    try:
        assert rec.get("gary_terminal") is None
        # inherit => override is None
        assert sessions_store.gary_terminal_override(rec["sessionKey"]) is None
        sessions_store.set_gary_terminal(rec["id"], True)
        assert sessions_store.gary_terminal_override(rec["sessionKey"]) is True
        sessions_store.set_gary_terminal(rec["id"], False)
        assert sessions_store.gary_terminal_override(rec["sessionKey"]) is False
        sessions_store.set_gary_terminal(rec["id"], None)
        assert sessions_store.gary_terminal_override(rec["sessionKey"]) is None
    finally:
        sessions_store.delete(rec["id"])


def test_gary_terminal_override_unknown_key_is_none():
    assert sessions_store.gary_terminal_override("no-such-key") is None


# --- MCP endpoints: auth/guard paths ----------------------------------------

def test_mcp_run_bad_token_404():
    r = TestClient(app).post("/api/terminal/mcp/run", json={"token": "bad"})
    assert r.status_code == 404


def test_mcp_run_gary_off_403(monkeypatch):
    token = terminals.mint_terminal_token("sess-off")
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: False)
    r = TestClient(app).post("/api/terminal/mcp/run", json={"token": token, "command": "echo hi"})
    assert r.status_code == 403


def test_mcp_write_bad_token_404():
    r = TestClient(app).post("/api/terminal/mcp/write", json={"token": "bad", "data": "x"})
    assert r.status_code == 404


def test_mcp_read_bad_token_404():
    r = TestClient(app).post("/api/terminal/mcp/read", json={"token": "bad"})
    assert r.status_code == 404


# --- MCP endpoints: happy path (real PTY) -----------------------------------

def test_mcp_run_happy_path(monkeypatch):
    key = "mcp-happy"
    token = terminals.mint_terminal_token(key)
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    try:
        r = TestClient(app).post(
            "/api/terminal/mcp/run",
            json={"token": token, "command": "printf MCP_OK", "timeout": 20},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert "MCP_OK" in body["output"], body
    finally:
        terminals.close_session(key)


def test_mcp_read_returns_buffer_tail(monkeypatch):
    key = "mcp-read"
    token = terminals.mint_terminal_token(key)
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    try:
        client = TestClient(app)
        client.post(
            "/api/terminal/mcp/run",
            json={"token": token, "command": "printf READ_OK", "timeout": 20},
        )
        r = client.post("/api/terminal/mcp/read", json={"token": token, "tail": 4000})
        assert r.status_code == 200, r.text
        body = r.json()
        assert "READ_OK" in body["output"], body
        assert body["running"] is True
    finally:
        terminals.close_session(key)
