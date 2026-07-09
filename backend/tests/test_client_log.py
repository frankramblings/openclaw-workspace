"""Task 18 — POST /api/client-log: sink for the frontend's global error
boundary (frontend-overrides/js/redesign/error-boundary.js). Covers the
contract from the task brief:
  - 204, no body, on a normal {msg, src, stack} post.
  - msg/src truncated to 500 chars, stack to 4000, before logging.
  - logged at WARNING under logger "client".
  - process-wide in-memory rate cap of 60/hour; beyond that, silently
    dropped (still 204 — never surfaces as an error to the fire-and-forget
    frontend caller).
  - malformed input (bad JSON, non-dict JSON, missing fields) never 500s;
    this implementation's explicit choice is a silent 204 drop (documented
    in app.py's client_log docstring).
  - inherits the auth gate like every other /api route (no bespoke auth).
"""
from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import config
from backend.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_rate_limit(monkeypatch):
    """The rate-limit timestamp list is process-wide module state — isolate
    every test from every other test (and from whatever order they run in)."""
    monkeypatch.setattr(app_module, "_CLIENT_LOG_TIMESTAMPS", [])


def test_client_log_accepts_normal_payload_and_returns_204():
    r = client.post("/api/client-log", json={
        "msg": "x is not a function",
        "src": "/static/js/redesign/app.js:42:7",
        "stack": "TypeError: x is not a function\n  at render (app.js:42:7)",
    })
    assert r.status_code == 204
    assert r.content == b""


def test_client_log_logs_at_warning_under_logger_client(caplog):
    with caplog.at_level(logging.WARNING, logger="client"):
        r = client.post("/api/client-log", json={
            "msg": "boom", "src": "a.js:1:1", "stack": "Error: boom",
        })
    assert r.status_code == 204
    records = [rec for rec in caplog.records if rec.name == "client"]
    assert len(records) == 1
    assert records[0].levelno == logging.WARNING
    msg = records[0].getMessage()
    assert "boom" in msg
    assert "a.js:1:1" in msg


def test_client_log_truncates_oversized_fields(caplog):
    long_msg = "m" * 600
    long_src = "s" * 600
    long_stack = "t" * 5000
    with caplog.at_level(logging.WARNING, logger="client"):
        r = client.post("/api/client-log", json={
            "msg": long_msg, "src": long_src, "stack": long_stack,
        })
    assert r.status_code == 204
    record = next(rec for rec in caplog.records if rec.name == "client")
    formatted = record.getMessage()
    # Truncated lengths land in the logged text ...
    assert "m" * 500 in formatted
    assert "s" * 500 in formatted
    assert "t" * 4000 in formatted
    # ... and the un-truncated tails must NOT.
    assert "m" * 501 not in formatted
    assert "s" * 501 not in formatted
    assert "t" * 4001 not in formatted


def test_client_log_rate_cap_silently_drops_beyond_60_per_hour(caplog):
    with caplog.at_level(logging.WARNING, logger="client"):
        responses = [
            client.post("/api/client-log", json={"msg": f"e{i}", "src": "a.js", "stack": ""})
            for i in range(65)
        ]
    # Every request still gets a clean 204 — the caller never sees the drop.
    assert all(r.status_code == 204 for r in responses)
    assert all(r.content == b"" for r in responses)
    records = [rec for rec in caplog.records if rec.name == "client"]
    assert len(records) == 60


def test_client_log_rate_cap_resets_after_the_window(monkeypatch, caplog):
    """Timestamps older than the 1h window are pruned, so the cap isn't a
    lifetime limit — it's a trailing-hour one. app.py's rate-limiter reads
    the module-level `time` import's .time(), so patching that same module
    object's `time` attribute controls what _client_log_rate_ok sees."""
    import time

    fake_now = [1_000_000.0]
    monkeypatch.setattr(time, "time", lambda: fake_now[0])

    with caplog.at_level(logging.WARNING, logger="client"):
        for i in range(60):
            client.post("/api/client-log", json={"msg": f"e{i}", "src": "a.js", "stack": ""})
        # 61st within the same hour is dropped.
        r = client.post("/api/client-log", json={"msg": "e60", "src": "a.js", "stack": ""})
        assert r.status_code == 204
        assert len([rec for rec in caplog.records if rec.name == "client"]) == 60

        # Jump the clock past the 1h window: the cap should reopen.
        fake_now[0] += app_module._CLIENT_LOG_RATE_WINDOW_S + 1
        r2 = client.post("/api/client-log", json={"msg": "post-window", "src": "a.js", "stack": ""})
        assert r2.status_code == 204

    records = [rec for rec in caplog.records if rec.name == "client"]
    assert len(records) == 61
    assert "post-window" in records[-1].getMessage()


def test_client_log_malformed_json_never_500s():
    r = client.post(
        "/api/client-log",
        content=b"{not valid json,,,",
        headers={"content-type": "application/json"},
    )
    assert r.status_code == 204
    assert r.content == b""


def test_client_log_non_object_json_never_500s(caplog):
    """A syntactically valid JSON body that isn't an object (e.g. a bare
    array) must degrade to empty fields, not crash."""
    with caplog.at_level(logging.WARNING, logger="client"):
        r = client.post("/api/client-log", json=[1, 2, 3])
    assert r.status_code == 204
    record = next(rec for rec in caplog.records if rec.name == "client")
    assert "unknown" in record.getMessage()  # empty src falls back to "unknown"


def test_client_log_empty_body_never_500s():
    r = client.post("/api/client-log")
    assert r.status_code == 204
    assert r.content == b""


def test_client_log_missing_fields_default_to_empty_strings(caplog):
    with caplog.at_level(logging.WARNING, logger="client"):
        r = client.post("/api/client-log", json={})
    assert r.status_code == 204
    record = next(rec for rec in caplog.records if rec.name == "client")
    assert "unknown" in record.getMessage()


# --- Auth gate inheritance: no bespoke auth on this route -------------------

def test_client_log_requires_auth_when_gate_is_active(monkeypatch):
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    with TestClient(app, raise_server_exceptions=True) as authed_client:
        r = authed_client.post("/api/client-log", json={"msg": "x"})
        assert r.status_code == 401

        r2 = authed_client.post(
            "/api/client-log", json={"msg": "x"},
            headers={"Authorization": "Bearer secret-token"},
        )
        assert r2.status_code == 204


def test_client_log_open_when_auth_gate_unset(monkeypatch):
    monkeypatch.setattr(config, "auth_token", lambda: None)
    r = client.post("/api/client-log", json={"msg": "x"})
    assert r.status_code == 204
