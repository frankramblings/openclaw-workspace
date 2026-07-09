"""Tests for the security response headers middleware + Secure cookie flag.

CSP starts Report-Only (WORKSPACE_CSP_ENFORCE unset) so a policy mistake can't
brick the installed PWA; flipping the env var moves the policy to the
enforcing header. The middleware wraps every HTTP response — including the
auth gate's 401s — because it is registered OUTERMOST in app.py (added AFTER
AuthGateMiddleware; Starlette's add_middleware inserts at position 0, so the
last middleware added becomes the outermost layer closest to the client).

Secure-flag-over-https is exercised via auth_gate's ?token= cookie mint,
covering both the direct-scheme case (base_url="https://...") and the
X-Forwarded-Proto case (Tailscale Serve terminates TLS in front of the app,
which itself is served plain-HTTP on loopback), plus the plain-http negative.
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
    """Fresh TestClient, no auth token, plain http scheme."""
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


@pytest.fixture()
def authed_client(monkeypatch):
    """TestClient with WORKSPACE_AUTH_TOKEN = 'secret-token', plain http."""
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


# ---------------------------------------------------------------------------
# Static headers present on every HTTP response
# ---------------------------------------------------------------------------

class TestStaticHeaders:
    def test_index_has_security_headers(self, client):
        r = client.get("/")
        assert r.headers.get("x-content-type-options") == "nosniff"
        assert r.headers.get("x-frame-options") == "DENY"
        assert r.headers.get("referrer-policy")
        assert r.headers.get("permissions-policy")

    def test_health_has_security_headers(self, client):
        """/api/health is on the auth allowlist but must still get headers —
        the middleware wraps ALL http responses, not just gated ones."""
        r = client.get("/api/health")
        assert r.status_code == 200
        assert r.headers.get("x-content-type-options") == "nosniff"
        assert r.headers.get("x-frame-options") == "DENY"
        assert r.headers.get("referrer-policy")
        assert r.headers.get("permissions-policy")


# ---------------------------------------------------------------------------
# CSP: Report-Only by default, enforcing when WORKSPACE_CSP_ENFORCE=1
# ---------------------------------------------------------------------------

class TestCSPReportOnlyDefault:
    def test_index_report_only_by_default(self, client, monkeypatch):
        monkeypatch.delenv("WORKSPACE_CSP_ENFORCE", raising=False)
        r = client.get("/")
        assert "content-security-policy-report-only" in r.headers
        assert "content-security-policy" not in r.headers

    def test_health_report_only_by_default(self, client, monkeypatch):
        monkeypatch.delenv("WORKSPACE_CSP_ENFORCE", raising=False)
        r = client.get("/api/health")
        assert "content-security-policy-report-only" in r.headers
        assert "content-security-policy" not in r.headers


class TestCSPEnforceFlip:
    def test_index_enforces_when_flag_set(self, client, monkeypatch):
        monkeypatch.setenv("WORKSPACE_CSP_ENFORCE", "1")
        r = client.get("/")
        assert "content-security-policy" in r.headers
        assert "content-security-policy-report-only" not in r.headers

    def test_health_enforces_when_flag_set(self, client, monkeypatch):
        monkeypatch.setenv("WORKSPACE_CSP_ENFORCE", "1")
        r = client.get("/api/health")
        assert "content-security-policy" in r.headers
        assert "content-security-policy-report-only" not in r.headers


# ---------------------------------------------------------------------------
# Ordering: headers must also land on auth-gate rejections (401/302 etc.)
# ---------------------------------------------------------------------------

class TestHeadersSurviveAuthGateRejection:
    def test_401_response_still_carries_security_headers(self, authed_client):
        r = authed_client.get("/api/config")  # no credential → 401
        assert r.status_code == 401
        assert r.headers.get("x-content-type-options") == "nosniff"
        assert r.headers.get("x-frame-options") == "DENY"
        assert "content-security-policy-report-only" in r.headers


# ---------------------------------------------------------------------------
# Cookie Secure flag: only appended when the request arrived over HTTPS,
# directly or via X-Forwarded-Proto (Tailscale Serve terminates TLS).
# ---------------------------------------------------------------------------

class TestCookieSecureFlag:
    def test_no_secure_flag_over_plain_http(self, authed_client):
        r = authed_client.get("/api/config?token=secret-token")
        assert r.status_code == 200
        cookie = r.headers.get("set-cookie")
        assert cookie is not None
        assert "; Secure" not in cookie

    def test_secure_flag_over_direct_https_scheme(self, monkeypatch):
        monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
        with TestClient(app, raise_server_exceptions=True,
                         base_url="https://testserver") as c:
            r = c.get("/api/config?token=secret-token")
        assert r.status_code == 200
        cookie = r.headers.get("set-cookie")
        assert cookie is not None
        assert "; Secure" in cookie

    def test_secure_flag_over_x_forwarded_proto_https(self, authed_client):
        r = authed_client.get("/api/config?token=secret-token",
                               headers={"X-Forwarded-Proto": "https"})
        assert r.status_code == 200
        cookie = r.headers.get("set-cookie")
        assert cookie is not None
        assert "; Secure" in cookie
