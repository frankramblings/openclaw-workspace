"""Tests for the optional auth gate (Part A + Part B).

Part A — username leak fix:
  /api/auth/status must NOT return "frank" by default; it must honor WORKSPACE_USER.

Part B — WORKSPACE_AUTH_TOKEN gate:
  - Unset → all routes open.
  - Set, no credential → 401 on protected route; /api/health always 200.
  - Set + correct Bearer → 200; wrong token → 401.
  - Set + correct ?token= → 200 AND workspace_auth cookie set.
  - Set + correct cookie → 200.

The middleware reads the token via config.auth_token() at request-time, so we
monkeypatch config.auth_token (and os.environ["WORKSPACE_USER"]) between cases.
"""

import pytest
from fastapi.testclient import TestClient

from backend import config
from backend.app import app

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def client():
    """Fresh TestClient with no auth token (default state)."""
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture()
def authed_client(monkeypatch):
    """TestClient with WORKSPACE_AUTH_TOKEN = 'secret-token'."""
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


# ---------------------------------------------------------------------------
# Part A — username default is not "frank" and honors WORKSPACE_USER
# ---------------------------------------------------------------------------

class TestAuthStatusUsername:
    def test_default_username_is_not_frank(self, client):
        """When WORKSPACE_USER is unset, username must NOT be 'frank'."""
        r = client.get("/api/auth/status")
        assert r.status_code == 200
        data = r.json()
        assert data["username"] != "frank"

    def test_default_username_is_admin(self, client, monkeypatch):
        """Without WORKSPACE_USER the default is 'admin'."""
        monkeypatch.delenv("WORKSPACE_USER", raising=False)
        r = client.get("/api/auth/status")
        assert r.json()["username"] == "admin"

    def test_workspace_user_env_honored(self, client, monkeypatch):
        """WORKSPACE_USER overrides the default."""
        monkeypatch.setenv("WORKSPACE_USER", "testuser")
        r = client.get("/api/auth/status")
        assert r.json()["username"] == "testuser"


# ---------------------------------------------------------------------------
# Part B — auth gate: token UNSET (complete no-op)
# ---------------------------------------------------------------------------

class TestAuthGateUnset:
    def test_health_open_without_token(self, client, monkeypatch):
        monkeypatch.setattr(config, "auth_token", lambda: None)
        r = client.get("/api/health")
        assert r.status_code == 200

    def test_config_open_without_token(self, client, monkeypatch):
        monkeypatch.setattr(config, "auth_token", lambda: None)
        r = client.get("/api/config")
        assert r.status_code == 200

    def test_auth_status_open_without_token(self, client, monkeypatch):
        monkeypatch.setattr(config, "auth_token", lambda: None)
        r = client.get("/api/auth/status")
        assert r.status_code == 200


# ---------------------------------------------------------------------------
# "Honest health" (Task 13): /api/health gains gateway state + disk-free
# decoration but must stay a no-IO, always-200 liveness probe — the
# doctor-alert timer (deploy/systemd/bin/openclaw-doctor-alert) polls it every
# 5 min expecting exactly that.
# ---------------------------------------------------------------------------

class TestHealthFields:
    def test_health_has_all_fields_with_sane_types(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200
        data = r.json()
        # Pre-existing fields keep their names/types.
        assert data["ok"] is True
        assert isinstance(data["session"], str)
        assert isinstance(data["has_password"], bool)
        assert isinstance(data["gateway"], str)  # was a ws:// URL; still a str
        # New fields (Task 13).
        assert data["gateway"] in ("ok", "restarting", "down")
        assert isinstance(data["disk_free_gb"], (int, float))
        assert data["disk_free_gb"] >= 0
        assert isinstance(data["tmp_free_gb"], (int, float))
        assert data["tmp_free_gb"] >= 0
        assert data["schema"] == 1

    def test_health_gateway_field_reflects_monitor_state(self, client, monkeypatch):
        """gateway now surfaces monitor.current_state() — the same source
        /api/gateway/status reads — instead of the static gateway_ws_url()
        that never changed and told you nothing about actual health."""
        from backend import monitor

        monkeypatch.setattr(monitor, "current_state", lambda: "down")
        assert client.get("/api/health").json()["gateway"] == "down"

        monkeypatch.setattr(monitor, "current_state", lambda: "restarting")
        assert client.get("/api/health").json()["gateway"] == "restarting"

    def test_health_never_awaits_monitor_status(self, client, monkeypatch):
        """/api/health must do zero gateway I/O (its docstring's — and the
        doctor-alert script's — load-bearing assumption): monitor.status() is
        the awaitable sibling that makes a live gateway RPC when state is
        "ok"; poison it and confirm /api/health still answers 200 without
        touching it."""
        from backend import monitor

        async def _boom(*a, **kw):
            raise AssertionError("must not be called by /api/health")

        monkeypatch.setattr(monitor, "status", _boom)
        r = client.get("/api/health")
        assert r.status_code == 200

    def test_health_survives_unreadable_disk_paths(self, client, monkeypatch):
        """A disk-usage read failure degrades a field to None, never a 500 —
        /api/health answering non-200 is exactly the alarm the doctor-alert
        timer is watching for, so this decoration must not be able to trip it."""
        from backend import app as app_module

        def _boom(_path):
            raise OSError("disk gone")

        monkeypatch.setattr(app_module.shutil, "disk_usage", _boom)
        r = client.get("/api/health")
        assert r.status_code == 200
        data = r.json()
        assert data["disk_free_gb"] is None
        assert data["tmp_free_gb"] is None


# ---------------------------------------------------------------------------
# Part B — auth gate: token SET
# ---------------------------------------------------------------------------

class TestAuthGateSet:
    def test_health_always_open(self, authed_client):
        """/api/health is allowlisted — never requires a token."""
        r = authed_client.get("/api/health")
        assert r.status_code == 200

    def test_no_credential_gets_401(self, authed_client):
        """Request with no credential → 401 on a gated route."""
        r = authed_client.get("/api/config")
        assert r.status_code == 401
        assert r.json()["error"] == "authentication required"

    def test_wrong_bearer_gets_401(self, authed_client):
        r = authed_client.get("/api/config",
                              headers={"Authorization": "Bearer wrong-token"})
        assert r.status_code == 401

    def test_correct_bearer_gets_200(self, authed_client):
        r = authed_client.get("/api/config",
                              headers={"Authorization": "Bearer secret-token"})
        assert r.status_code == 200

    def test_correct_x_workspace_token_gets_200(self, authed_client):
        r = authed_client.get("/api/config",
                              headers={"X-Workspace-Token": "secret-token"})
        assert r.status_code == 200

    def test_wrong_x_workspace_token_gets_401(self, authed_client):
        r = authed_client.get("/api/config",
                              headers={"X-Workspace-Token": "bad-token"})
        assert r.status_code == 401

    def test_correct_query_param_gets_200_and_sets_cookie(self, authed_client):
        """?token= authenticates AND sets workspace_auth cookie."""
        r = authed_client.get("/api/config?token=secret-token")
        assert r.status_code == 200
        # Cookie must be present in the response
        assert "workspace_auth" in r.cookies

    def test_wrong_query_param_gets_401(self, authed_client):
        r = authed_client.get("/api/config?token=wrong-token")
        assert r.status_code == 401

    def test_correct_cookie_gets_200(self, authed_client):
        """Request with workspace_auth cookie authenticates correctly."""
        r = authed_client.get("/api/config",
                              cookies={"workspace_auth": "secret-token"})
        assert r.status_code == 200

    def test_wrong_cookie_gets_401(self, authed_client):
        r = authed_client.get("/api/config",
                              cookies={"workspace_auth": "bad-cookie"})
        assert r.status_code == 401


# ---------------------------------------------------------------------------
# Part B — auth_required reflected in /api/auth/features
# ---------------------------------------------------------------------------

class TestAuthFeatures:
    def test_auth_required_false_when_no_token(self, client, monkeypatch):
        monkeypatch.setattr(config, "auth_token", lambda: None)
        r = client.get("/api/auth/features")
        assert r.json()["auth_required"] is False

    def test_auth_required_true_when_token_set(self, authed_client):
        r = authed_client.get("/api/auth/features",
                              headers={"Authorization": "Bearer secret-token"})
        assert r.json()["auth_required"] is True


# ---------------------------------------------------------------------------
# Part B — auth gate covers WebSockets (the terminal shell is a WS)
# ---------------------------------------------------------------------------

def _ws_app():
    """Minimal Starlette app with one WS echo route behind the auth gate — keeps
    the test off the real terminal handler (which would fork a PTY)."""
    from starlette.applications import Starlette
    from starlette.routing import WebSocketRoute
    from starlette.middleware import Middleware
    from backend import auth_gate

    async def ws_echo(websocket):
        await websocket.accept()
        await websocket.send_text("ok")
        await websocket.close()

    return Starlette(routes=[WebSocketRoute("/ws", ws_echo)],
                     middleware=[Middleware(auth_gate.AuthGateMiddleware)])


def test_websocket_open_when_no_token(monkeypatch):
    from starlette.testclient import TestClient
    monkeypatch.setattr(config, "auth_token", lambda: None)
    client = TestClient(_ws_app())
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_text() == "ok"


def test_websocket_rejected_without_credential(monkeypatch):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    client = TestClient(_ws_app())
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws"):
            pass


def test_websocket_rejected_with_wrong_token(monkeypatch):
    from starlette.testclient import TestClient
    from starlette.websockets import WebSocketDisconnect
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    client = TestClient(_ws_app())
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws?token=nope"):
            pass


def test_websocket_accepted_with_query_token(monkeypatch):
    from starlette.testclient import TestClient
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    client = TestClient(_ws_app())
    with client.websocket_connect("/ws?token=secret-token") as ws:
        assert ws.receive_text() == "ok"


def test_websocket_accepted_with_cookie(monkeypatch):
    from starlette.testclient import TestClient
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    client = TestClient(_ws_app())
    client.cookies.set("workspace_auth", "secret-token")
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_text() == "ok"


def test_streaming_response_not_buffered_through_gate(monkeypatch):
    """The gate must not buffer streaming bodies (chat SSE is load-bearing).
    Drive a multi-chunk StreamingResponse through the ASGI middleware and assert
    each chunk arrives as its own http.response.body message."""
    import anyio
    from starlette.applications import Starlette
    from starlette.responses import StreamingResponse
    from starlette.routing import Route
    from starlette.middleware import Middleware
    from backend import auth_gate, config

    monkeypatch.setattr(config, "auth_token", lambda: None)  # passthrough mode

    async def stream(_request):
        async def gen():
            for i in range(3):
                yield f"data: {i}\n\n".encode()
        return StreamingResponse(gen(), media_type="text/event-stream")

    app = Starlette(routes=[Route("/s", stream)],
                    middleware=[Middleware(auth_gate.AuthGateMiddleware)])

    bodies = []

    async def main():
        scope = {"type": "http", "method": "GET", "path": "/s",
                 "headers": [], "query_string": b""}
        ev = anyio.Event()

        async def receive():
            await ev.wait()
            return {"type": "http.disconnect"}

        async def send(m):
            if m["type"] == "http.response.body" and m.get("body"):
                bodies.append(m["body"])
                if len(bodies) >= 3:
                    ev.set()
        with anyio.move_on_after(3):
            await app(scope, receive, send)

    anyio.run(main)
    assert bodies == [b"data: 0\n\n", b"data: 1\n\n", b"data: 2\n\n"]
