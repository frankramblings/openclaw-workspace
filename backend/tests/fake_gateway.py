"""A programmable stand-in for bridge.gateway_call_result for the Pillar D
tests. Responses are keyed by method name: a dict or list is returned as the
payload, an Exception instance is raised (a connection failure), a
callable(params) is invoked and its return used as the payload, and
error(method, code, message) programs an ok:false frame. A response dict of
the form {"__error__": {"code", "message"}} (also from a callable) yields an
ok:false frame, which is how a test scripts "first call ok, second stale".
Every call is recorded in .calls as (method, params)."""
from __future__ import annotations

from backend import bridge


class FakeGateway:
    def __init__(self, responses: dict | None = None):
        self.responses: dict = dict(responses or {})
        self.calls: list[tuple[str, dict]] = []

    def error(self, method: str, code: str, message: str) -> "FakeGateway":
        self.responses[method] = {"__error__": {"code": code, "message": message}}
        return self

    def calls_for(self, method: str) -> list[dict]:
        return [p for m, p in self.calls if m == method]

    def install(self, monkeypatch) -> "FakeGateway":
        async def fake(method, params=None, timeout=30.0):
            self.calls.append((method, dict(params or {})))
            if method not in self.responses:
                return {"ok": False, "payload": {},
                        "error": {"code": "INVALID_REQUEST", "message": f"unknown method: {method}"}}
            resp = self.responses[method]
            if isinstance(resp, Exception):
                raise resp
            if callable(resp):
                resp = resp(dict(params or {}))
            if isinstance(resp, dict) and "__error__" in resp:
                return {"ok": False, "payload": {}, "error": resp["__error__"]}
            return {"ok": True, "payload": resp, "error": None}
        monkeypatch.setattr(bridge, "gateway_call_result", fake)
        return self
