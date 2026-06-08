"""Tests for the desktop 'open in default browser' fallback endpoint.

The endpoint shells out to macOS `open <url>`, so the URL validator is a
security boundary: only plain http(s) URLs may pass (no file://, app opens,
or option-injection via a leading dash)."""
import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox


@pytest.fixture
def anyio_backend():
    return "asyncio"


# --- pure validator ------------------------------------------------------

def test_validate_accepts_http_and_https():
    assert inbox.validate_open_url("http://example.com/x") == "http://example.com/x"
    assert inbox.validate_open_url(
        "https://mail.google.com/mail/u/0/#inbox") == \
        "https://mail.google.com/mail/u/0/#inbox"


@pytest.mark.parametrize("bad", [
    "file:///etc/passwd",        # local file read
    "ftp://host/x",              # non-web scheme
    "javascript:alert(1)",       # script scheme
    "-e",                        # option injection into `open`
    "--args",                    # option injection
    "/Applications/Calculator.app",  # app/file path
    "",                          # empty
    "   ",                       # whitespace only
    None,                        # non-string
])
def test_validate_rejects_non_web_or_flag(bad):
    with pytest.raises(ValueError):
        inbox.validate_open_url(bad)


# --- route ---------------------------------------------------------------

@pytest.fixture
def client():
    from backend.app import app
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://t")


@pytest.mark.anyio
async def test_open_route_runs_open_for_valid_url(client, monkeypatch):
    calls = []
    monkeypatch.setattr(inbox.subprocess, "run",
                        lambda *a, **k: calls.append(a) or None)
    async with client as c:
        r = await c.post("/api/items/open", json={"url": "https://example.com"})
    assert r.status_code == 200
    assert r.json()["success"] is True
    assert calls and calls[0][0] == ["open", "https://example.com"]


@pytest.mark.anyio
async def test_open_route_rejects_bad_url_without_shelling_out(client, monkeypatch):
    calls = []
    monkeypatch.setattr(inbox.subprocess, "run",
                        lambda *a, **k: calls.append(a) or None)
    async with client as c:
        r = await c.post("/api/items/open", json={"url": "file:///etc/passwd"})
    assert r.status_code == 400
    assert calls == []
