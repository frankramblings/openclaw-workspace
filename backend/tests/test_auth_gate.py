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
import os

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
