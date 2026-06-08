"""Doctor maps gateway states (reachable/auth/unknown-method) to {ok, hint}."""
import asyncio

import pytest

from backend import doctor


def _run(monkeypatch, hello=None, call=None):
    async def fake_hello(timeout=10.0):
        if isinstance(hello, Exception):
            raise hello
        return hello if hello is not None else {}

    async def fake_call(method, params=None, timeout=30.0):
        if isinstance(call, Exception):
            raise call
        if callable(call):
            return call(method)
        return {}

    monkeypatch.setattr(doctor.bridge, "gateway_hello", fake_hello)
    monkeypatch.setattr(doctor.bridge, "gateway_call", fake_call)
    return asyncio.run(doctor.run_checks())


def _check(result, cid):
    return next(c for c in result if c["id"] == cid)


def test_unreachable_gateway(monkeypatch):
    res = _run(monkeypatch, hello=ConnectionRefusedError())
    assert _check(res, "gateway_reachable")["ok"] is False
    assert "unreachable" in _check(res, "gateway_reachable")["hint"].lower()


def test_auth_rejected(monkeypatch):
    res = _run(monkeypatch, hello=RuntimeError("gateway connect failed: AUTH"))
    c = _check(res, "gateway_reachable")
    assert c["ok"] is False and "password" in c["hint"].lower()


def test_healthy_gateway_and_methods(monkeypatch):
    res = _run(monkeypatch, hello={"version": "2026.6.1"},
               call=lambda m: {"ok": True})
    assert _check(res, "gateway_reachable")["ok"] is True
    assert _check(res, "methods")["ok"] is True
    assert "2026.6.1" in _check(res, "openclaw_version")["detail"]


def test_missing_method(monkeypatch):
    def call(m):
        if m == "skills.status":
            raise RuntimeError("skills.status failed: unknown method")
        return {"ok": True}
    res = _run(monkeypatch, hello={}, call=call)
    c = _check(res, "methods")
    assert c["ok"] is False and "skills.status" in c["detail"]


def test_bad_url_is_structured_fail_not_crash(monkeypatch):
    # A misconfigured ws URL raises a WebSocketException — the doctor must report
    # a structured FAIL, never let it crash run_checks (which would be HTTP 500).
    import websockets.exceptions
    res = _run(monkeypatch, hello=websockets.exceptions.WebSocketException("bad url"))
    assert _check(res, "gateway_reachable")["ok"] is False


def test_aggregate_ok_is_and_of_fatals(monkeypatch):
    res = _run(monkeypatch, hello=ConnectionRefusedError())
    assert doctor.summarize(res)["ok"] is False
