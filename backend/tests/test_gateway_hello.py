"""gateway_hello returns the connect-response payload (version/caps) and raises
RuntimeError when the handshake is rejected — same failure contract as gateway_call."""
import asyncio

import pytest

from backend import bridge


class _FakeWS:
    def __init__(self, hello):
        self._hello = hello

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def test_gateway_hello_returns_payload(monkeypatch):
    async def fake_request(ws, method, params=None):
        return {"ok": True, "payload": {"version": "2026.6.1"}}

    monkeypatch.setattr(bridge, "_request", fake_request)
    monkeypatch.setattr(bridge, "_wait_for_challenge", lambda ws: asyncio.sleep(0))
    monkeypatch.setattr(bridge.websockets, "connect", lambda *a, **k: _FakeWS(None))
    out = asyncio.run(bridge.gateway_hello())
    assert out["version"] == "2026.6.1"


def test_gateway_hello_raises_on_reject(monkeypatch):
    async def fake_request(ws, method, params=None):
        return {"ok": False, "error": "AUTH_PASSWORD_MISSING"}

    monkeypatch.setattr(bridge, "_request", fake_request)
    monkeypatch.setattr(bridge, "_wait_for_challenge", lambda ws: asyncio.sleep(0))
    monkeypatch.setattr(bridge.websockets, "connect", lambda *a, **k: _FakeWS(None))
    with pytest.raises(RuntimeError, match="connect failed"):
        asyncio.run(bridge.gateway_hello())
