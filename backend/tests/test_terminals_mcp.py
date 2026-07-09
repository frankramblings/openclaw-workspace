"""Gary-drive (PR2 Task 1): per-turn token map, Gary-mode resolution, and the
loopback MCP-facing terminal endpoints."""
import time

import pytest
from fastapi.testclient import TestClient

from backend import sessions_store, terminals, websearch
from backend.app import app


@pytest.fixture(autouse=True)
def _allow_mcp_access(monkeypatch):
    # The MCP endpoints now run the terminal access guard, and FastAPI's
    # TestClient reports a non-loopback host ("testclient") with no Serve
    # identity header — which the guard rejects by default. Flip the escape
    # hatch so these tests exercise the endpoints' own token/gary logic rather
    # than the transport guard (guard behavior is covered in test_terminals.py).
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")


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


def test_mcp_read_gary_off_403(monkeypatch):
    # A capability token minted while Gary-control was ON must NOT still allow
    # buffer reads once the user flips Gary-mode OFF for the session — the
    # token's 30-min TTL otherwise leaves a read-only side channel open. Must
    # mirror mcp/run and mcp/write's exact rejection shape (403, same body).
    token = terminals.mint_terminal_token("sess-read-off")
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: False)
    r = TestClient(app).post("/api/terminal/mcp/read", json={"token": token})
    assert r.status_code == 403
    assert r.json() == {"detail": "Gary terminal control is off for this chat"}


# --- MCP endpoints route through the SAME transport gate as the human WS
# (Task 14, cell e). Gary's real production calls arrive as GENUINE loopback
# (127.0.0.1) with no Serve identity header and — by default — no
# WORKSPACE_AUTH_TOKEN. The task's default-deny-plain-loopback change must
# NOT lock those out; a resolved per-turn capability token is itself the auth
# factor. These tests undo the file's blanket `_allow_mcp_access` escape
# hatch to exercise the REAL default posture (REQUIRE_TSHEADER=1, no
# ALLOW_PLAIN_LOOPBACK) with a TestClient that reports a true loopback host.

@pytest.fixture
def loopback_client(monkeypatch):
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "1")
    monkeypatch.delenv("OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK", raising=False)
    return TestClient(app, client=("127.0.0.1", 51234))


def test_mcp_run_capability_token_allows_genuine_loopback_by_default(monkeypatch, loopback_client):
    key = "mcp-cap-run"
    token = terminals.mint_terminal_token(key)
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    try:
        r = loopback_client.post(
            "/api/terminal/mcp/run",
            json={"token": token, "command": "printf CAP_OK", "timeout": 20},
        )
        assert r.status_code == 200, r.text
        assert "CAP_OK" in r.json()["output"]
    finally:
        terminals.close_session(key)


def test_mcp_read_capability_token_allows_genuine_loopback_by_default(loopback_client):
    token = terminals.mint_terminal_token("mcp-cap-read")
    r = loopback_client.post("/api/terminal/mcp/read", json={"token": token})
    assert r.status_code == 200, r.text


def test_mcp_write_capability_token_allows_genuine_loopback_by_default(monkeypatch, loopback_client):
    key = "mcp-cap-write"
    token = terminals.mint_terminal_token(key)
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    try:
        r = loopback_client.post("/api/terminal/mcp/write", json={"token": token, "data": "x"})
        assert r.status_code == 200, r.text
    finally:
        terminals.close_session(key)


def test_mcp_run_bad_token_from_genuine_loopback_is_403_not_404(loopback_client):
    # Neither transport trust (no header, no opt-in) nor a resolvable
    # capability token -> the transport gate now denies BEFORE the
    # token-detail 404 branch (previously plain loopback was trusted
    # unconditionally, so this case always reached the token check).
    r = loopback_client.post("/api/terminal/mcp/run", json={"token": "bad", "command": "echo hi"})
    assert r.status_code == 403


def test_mcp_run_capability_token_alone_does_not_bypass_loopback_requirement(monkeypatch):
    # A resolvable token from a NON-loopback client_host is still denied —
    # matches the PR2 audit's "token + gary_mode + loopback", all three.
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "1")
    monkeypatch.delenv("OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK", raising=False)
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    key = "mcp-cap-remote"
    token = terminals.mint_terminal_token(key)
    client = TestClient(app, client=("100.64.1.9", 51234))
    r = client.post("/api/terminal/mcp/run", json={"token": token, "command": "echo hi"})
    assert r.status_code == 403


def test_mcp_run_malformed_body_from_untrusted_transport_still_403(monkeypatch):
    # A malformed JSON body from an untrusted transport must not leak a parse
    # error before the auth decision — it degrades to "no token" and the
    # transport gate still denies cleanly. (Override the file's blanket
    # escape-hatch fixture so the transport is actually untrusted here.)
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "1")
    monkeypatch.delenv("OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK", raising=False)
    client = TestClient(app, client=("100.64.1.9", 51234))
    r = client.post(
        "/api/terminal/mcp/run",
        content=b"{not json",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 403


# --- gary-mode routes -------------------------------------------------------

def test_gary_mode_get_returns_three_keys(monkeypatch):
    monkeypatch.setattr(terminals, "gary_mode_default", lambda: True)
    monkeypatch.setattr(sessions_store, "gary_terminal_override", lambda k: None)
    r = TestClient(app).get("/api/terminal/gary-mode", params={"session_key": "k"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body.keys()) == {"global_default", "override", "effective"}
    assert body == {"global_default": True, "override": None, "effective": True}


def test_gary_mode_set_global_flips_default(monkeypatch):
    saved = {}

    def _save(patch):
        saved.update(patch or {})
        return saved

    monkeypatch.setattr(websearch, "save_settings", _save)
    # gary_mode_default reads load_settings; reflect what was saved.
    monkeypatch.setattr(
        websearch, "load_settings",
        lambda: {"gary_terminal_default": saved.get("gary_terminal_default", True)},
    )
    r = TestClient(app).post("/api/terminal/gary-mode", json={"scope": "global", "enabled": False})
    assert r.status_code == 200, r.text
    assert saved.get("gary_terminal_default") is False
    assert r.json()["global_default"] is False


def test_gary_mode_set_session_override(monkeypatch):
    monkeypatch.setattr(sessions_store, "id_for_session_key", lambda k: "rec-id" if k == "the-key" else None)
    captured = {}
    monkeypatch.setattr(sessions_store, "set_gary_terminal",
                        lambda sid, enabled: captured.update(sid=sid, enabled=enabled))
    monkeypatch.setattr(sessions_store, "gary_terminal_override", lambda k: False)
    monkeypatch.setattr(terminals, "gary_mode_default", lambda: True)
    r = TestClient(app).post(
        "/api/terminal/gary-mode",
        json={"scope": "session", "session_key": "the-key", "enabled": False},
    )
    assert r.status_code == 200, r.text
    assert captured == {"sid": "rec-id", "enabled": False}
    assert r.json()["effective"] is False


def test_gary_mode_set_session_unknown_404(monkeypatch):
    monkeypatch.setattr(sessions_store, "id_for_session_key", lambda k: None)
    r = TestClient(app).post(
        "/api/terminal/gary-mode",
        json={"scope": "session", "session_key": "nope", "enabled": True},
    )
    assert r.status_code == 404


def test_gary_mode_set_bad_scope_400():
    r = TestClient(app).post("/api/terminal/gary-mode", json={"scope": "bad"})
    assert r.status_code == 400


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


# --- buffer rotation: monotonic total_written --------------------------------

def test_total_written_survives_buffer_rotation():
    sess = terminals.PtySession("rot-test")
    # don't start a real PTY; just exercise the buffer accounting
    sess._append("A" * (terminals.MAX_BUFFER - 10))
    cursor = sess.total_written           # mark position
    sess._append("B" * 5000)              # pushes past the cap -> front evicted
    new_chars = sess.total_written - cursor
    assert new_chars == 5000
    tail = sess.buffer[-new_chars:] if new_chars <= len(sess.buffer) else sess.buffer
    assert tail == "B" * 5000             # full post-cursor output, not truncated to 10
    assert len(sess.buffer) == terminals.MAX_BUFFER


def test_await_settled_output_slice_matches_after_cap():
    """_await_settled_output, given a pre-cap total_written cursor, must return
    exactly the post-cursor chars (clamped to the rotated buffer) — proving the
    settle/slice path uses the monotonic counter, not len(buffer)."""
    import asyncio

    sess = terminals.PtySession("rot-settle")
    sess._append("A" * (terminals.MAX_BUFFER - 10))
    cursor = sess.total_written
    sess._append("B" * 5000)  # crosses the cap; len(buffer) no longer grew by 5000

    async def _run():
        # settle short so the already-quiet buffer returns immediately.
        return await terminals._await_settled_output(sess, cursor, settle=0.05, cap=2.0)

    out = asyncio.run(_run())
    assert out == "B" * 5000


def test_capability_note_contains_token_and_endpoint():
    note = terminals.gary_capability_note("agent:main:web-xyz")
    assert "/api/terminal/mcp/run" in note and '"token":"' in note
    # the fast path is a direct curl, NOT a node-cold-start mcporter call
    assert "mcporter call" not in note


def test_strip_capability_note_roundtrip():
    note = terminals.gary_capability_note("agent:main:web-xyz")
    assert terminals.strip_capability_note(note + "hello world") == "hello world"
    assert terminals.strip_capability_note("no note here") == "no note here"


def test_strip_capability_note_is_anchored_no_truncation():
    # A legit user message that merely CONTAINS the marker mid-text (paste / echo)
    # must NOT be truncated — only a leading injected block is stripped.
    marker = terminals._GARY_NOTE_PREFIX
    msg = f"real user text {marker} and more text after, no strip"
    assert terminals.strip_capability_note(msg) == msg
    msg2 = f"line one\n\nsecond para mentioning {marker} here"
    assert terminals.strip_capability_note(msg2) == msg2


def test_chat_stream_binds_gary_token_to_spa_id(monkeypatch):
    """Regression guard for the load-bearing invariant: a turn's injected terminal
    token must resolve to the chat's SPA id (rec['id']) — the SAME key the human
    panel uses for its PTY — NOT the gateway sessionKey. If app.py ever reverts to
    minting with sessionKey, Gary drives a different terminal than the user sees."""
    import re

    from backend import app as app_module
    from backend import bridge

    rec = sessions_store.create(name="bind-test")  # id != sessionKey (prefix-embedded)
    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kwargs):
        sent["message"] = message
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    try:
        res = TestClient(app).post("/api/chat_stream", data={"message": "hi", "session": rec["id"]})
        assert res.status_code == 200
        m = re.search(r'"token":"([^"]+)"', sent.get("message", ""))
        assert m, f"no token injected: {sent.get('message')!r}"
        resolved = terminals.resolve_terminal_token(m.group(1))
        assert resolved == rec["id"]
        assert resolved != rec["sessionKey"]
    finally:
        sessions_store.delete(rec["id"])
        terminals.close_session(rec["id"])


def test_mcp_run_sequential_captures_real_output(monkeypatch):
    """Guards the shell-quiescent fix: a fresh (cold) shell, a warm shell, and a
    multi-line command must each return their REAL output, not just the echoed
    command. Uses httpx ASGITransport in ONE event loop (production-like); the
    TestClient spins a fresh loop per request which strands the PTY reader and so
    can't exercise sequential runs. A marker appearing >=2x means it's in both the
    command echo AND the actual output (i.e. output was captured)."""
    import asyncio

    import httpx

    from backend.app import app as asgi_app

    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    key = "seq-capture"
    tok = terminals.mint_terminal_token(key)

    async def main():
        transport = httpx.ASGITransport(app=asgi_app)
        async with httpx.AsyncClient(transport=transport, base_url="http://t") as client:
            async def run(cmd):
                r = await client.post("/api/terminal/mcp/run", json={"token": tok, "command": cmd})
                assert r.status_code == 200, r.text
                return r.json()["output"]
            return (
                await run("echo COLD_111"),
                await run("echo WARM_222"),
                await run("printf 'A\\nB\\nC\\n' && echo MULTI_333"),
            )

    try:
        cold, warm, multi = asyncio.run(main())
        assert cold.count("COLD_111") >= 2, repr(cold)
        assert warm.count("WARM_222") >= 2, repr(warm)
        assert multi.count("MULTI_333") >= 2, repr(multi)
    finally:
        terminals.close_session(key)
