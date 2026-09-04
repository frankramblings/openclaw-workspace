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
import re

import pytest
from fastapi import Request
from fastapi.testclient import TestClient

from backend import config
from backend.app import app
from backend.security_headers import build_policy, request_nonce


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

    def test_csp_policy_value_complete(self, client, monkeypatch):
        """Verify the full CSP policy string value (not just header presence).
        A typo in the policy would pass the 'header in response' test but fail
        here. The expected policy is copied verbatim so edits to
        security_headers.build_policy must also update this literal. The only
        per-request part is the script-src nonce, which is spliced in from the
        response's own header rather than hardcoded."""
        monkeypatch.delenv("WORKSPACE_CSP_ENFORCE", raising=False)
        r = client.get("/")
        policy = r.headers.get("content-security-policy-report-only")
        m = re.search(r"'nonce-([A-Za-z0-9_-]+)'", policy)
        assert m, f"no nonce in script-src: {policy}"
        expected_policy = (
            "default-src 'self'; img-src 'self' data: blob:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self' "
            f"'nonce-{m.group(1)}'; "
            "connect-src 'self' ws: wss:; worker-src 'self'; "
            "frame-ancestors 'none'"
        )
        assert policy == expected_policy

    def test_script_src_never_gets_unsafe_inline(self, client, monkeypatch):
        """A nonce plus 'unsafe-inline' is a silent downgrade: nonce-aware
        browsers drop 'unsafe-inline', older ones honour it. Neither header
        variant may carry it."""
        for enforce in ("1", None):
            if enforce:
                monkeypatch.setenv("WORKSPACE_CSP_ENFORCE", enforce)
            else:
                monkeypatch.delenv("WORKSPACE_CSP_ENFORCE", raising=False)
            r = client.get("/")
            policy = (r.headers.get("content-security-policy")
                      or r.headers.get("content-security-policy-report-only"))
            script_src = [d for d in policy.split(";") if "script-src" in d][0]
            assert "'unsafe-inline'" not in script_src


# ---------------------------------------------------------------------------
# Per-request CSP nonce
# ---------------------------------------------------------------------------

class TestCSPNonce:
    def test_nonce_differs_between_requests(self, client, monkeypatch):
        """One fresh nonce per request. A reused nonce is worth little more
        than 'unsafe-inline' once any page echoes user content."""
        monkeypatch.delenv("WORKSPACE_CSP_ENFORCE", raising=False)
        seen = set()
        for _ in range(5):
            policy = client.get("/").headers["content-security-policy-report-only"]
            m = re.search(r"'nonce-([A-Za-z0-9_-]+)'", policy)
            assert m
            seen.add(m.group(1))
        assert len(seen) == 5, f"nonces repeated across requests: {seen}"

    def test_header_nonce_matches_scope_state(self, monkeypatch):
        """The value in script-src must be the same one route handlers read off
        request.state.csp_nonce, or an injected script would be blocked."""
        monkeypatch.delenv("WORKSPACE_CSP_ENFORCE", raising=False)
        captured = {}

        @app.get("/__test_nonce_echo")
        async def _echo(request: Request):
            captured["state"] = request.state.csp_nonce
            captured["helper"] = request_nonce(request.scope)
            return {"ok": True}

        try:
            with TestClient(app, raise_server_exceptions=True) as c:
                r = c.get("/__test_nonce_echo")
            assert r.status_code == 200
            m = re.search(r"'nonce-([A-Za-z0-9_-]+)'",
                          r.headers["content-security-policy-report-only"])
            assert m
            assert captured["state"] == m.group(1)
            assert captured["helper"] == m.group(1)
        finally:
            app.router.routes = [rt for rt in app.router.routes
                                 if getattr(rt, "path", None) != "/__test_nonce_echo"]

    def test_nonce_present_in_enforcing_header_too(self, client, monkeypatch):
        monkeypatch.setenv("WORKSPACE_CSP_ENFORCE", "1")
        policy = client.get("/").headers["content-security-policy"]
        assert re.search(r"script-src 'self' 'nonce-[A-Za-z0-9_-]+'", policy)

    def test_build_policy_without_nonce_is_the_plain_policy(self):
        """Defensive: build_policy("") must not emit a malformed 'nonce-'
        token. Reached only if a response somehow bypasses the middleware."""
        assert b"nonce" not in build_policy("")
        assert b"script-src 'self';" in build_policy("")


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
