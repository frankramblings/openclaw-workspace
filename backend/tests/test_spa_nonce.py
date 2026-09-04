"""The base-path shim _spa_html() injects is inline, so it must carry the
request's CSP nonce or a base-path tenant can never set WORKSPACE_CSP_ENFORCE=1.

These build a real ASGI stack (SecurityHeadersMiddleware wrapping a route that
calls the real _spa_html) instead of using backend.app's own client, because
backend/app.py only registers `GET /` when config.FRONTEND_DIR exists at import
time; in a fresh checkout frontend/ is the gitignored build output and is
absent, so `/` is the 500 "frontend not found" fallback and would prove nothing.
Everything under test here (the middleware, _spa_html, the nonce handoff) is the
production code path, only the route registration is local.
"""
import re

import pytest
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.routing import Route

from backend import config
from backend.app import _spa_html
from backend.security_headers import SecurityHeadersMiddleware

INDEX = "<!DOCTYPE html>\n<html><head><title>t</title></head>\n<body><script src=\"/static/js/app.js\"></script></body></html>\n"


@pytest.fixture()
def spa_client(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text(INDEX, encoding="utf-8")
    monkeypatch.setattr(config, "FRONTEND_DIR", tmp_path)

    async def index(request: Request):
        return _spa_html("index.html", request)

    app = Starlette(routes=[Route("/", index)])
    app.add_middleware(SecurityHeadersMiddleware)
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


def header_nonce(response):
    policy = (response.headers.get("content-security-policy")
              or response.headers.get("content-security-policy-report-only"))
    m = re.search(r"'nonce-([A-Za-z0-9_-]+)'", policy)
    assert m, f"no nonce in {policy}"
    return m.group(1)


class TestBasePathInjectionCarriesTheNonce:
    def test_both_injected_scripts_carry_the_header_nonce(self, spa_client, monkeypatch):
        monkeypatch.setattr(config, "BASE_PATH", "/x")
        monkeypatch.setenv("WORKSPACE_CSP_ENFORCE", "1")
        r = spa_client.get("/")
        assert r.status_code == 200
        nonce = header_nonce(r)
        body = r.text
        assert f'<script type="importmap" nonce="{nonce}">' in body
        assert f'<script nonce="{nonce}">(function(){{var B="/x";' in body
        # Every script tag in the body is either external or nonced.
        for tag in re.findall(r"<script\b[^>]*>", body):
            assert "src=" in tag or f'nonce="{nonce}"' in tag, tag

    def test_nonce_changes_per_request(self, spa_client, monkeypatch):
        monkeypatch.setattr(config, "BASE_PATH", "/x")
        first = spa_client.get("/")
        second = spa_client.get("/")
        assert header_nonce(first) != header_nonce(second)
        assert f'nonce="{header_nonce(first)}"' in first.text
        assert f'nonce="{header_nonce(second)}"' in second.text

    def test_base_path_rewriting_still_happens(self, spa_client, monkeypatch):
        """The nonce change must not disturb what the shim was for."""
        monkeypatch.setattr(config, "BASE_PATH", "/x")
        body = spa_client.get("/").text
        assert 'src="/x/static/js/app.js"' in body
        assert '{"imports":{"/static/":"/x/static/"}}' in body


class TestNoBasePathServesTheFileUntouched:
    def test_no_nonce_attribute_in_the_body(self, spa_client, monkeypatch):
        """With no BASE_PATH nothing is injected, so nothing in the body needs a
        nonce. The HEADER still carries one: the middleware mints it for every
        request so the policy string is uniform and a route that starts
        injecting later cannot forget to ask for one. An unreferenced nonce
        grants nothing."""
        monkeypatch.setattr(config, "BASE_PATH", "")
        r = spa_client.get("/")
        assert r.status_code == 200
        assert r.text == INDEX
        assert "nonce" not in r.text
        assert header_nonce(r)
