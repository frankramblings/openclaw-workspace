"""Gateway log tail relay: param caps, envelope, second secret scrub."""
import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.tests.fake_gateway import FakeGateway

TAIL = {"file": "/tmp/openclaw/openclaw-2026-09-03.log", "cursor": 2185287, "size": 2185287,
        "lines": ["2026-09-03 info ok", "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF"],
        "truncated": True}


@pytest.fixture
def client():
    return TestClient(app)


def test_tail_defaults_and_envelope(client, monkeypatch):
    fake = FakeGateway({"logs.tail": TAIL}).install(monkeypatch)
    r = client.get("/api/logs/tail")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["file"].endswith(".log") and body["cursor"] == 2185287 and body["size"] == 2185287
    assert body["truncated"] is True and body["reset"] is False
    assert body["lines"][0] == "2026-09-03 info ok"
    assert "sk-abcdefghij" not in body["lines"][1] and "REDACTED" in body["lines"][1]
    assert fake.calls == [("logs.tail", {"limit": 200, "maxBytes": 100000})]


def test_tail_passes_cursor_and_caps(client, monkeypatch):
    fake = FakeGateway({"logs.tail": {**TAIL, "reset": True}}).install(monkeypatch)
    r = client.get("/api/logs/tail?cursor=12&limit=5&max_bytes=1000")
    assert r.status_code == 200 and r.json()["reset"] is True
    assert fake.calls == [("logs.tail", {"cursor": 12, "limit": 5, "maxBytes": 1000})]


@pytest.mark.parametrize("qs", ["limit=0", "limit=2001", "max_bytes=0", "max_bytes=500001", "cursor=-1"])
def test_tail_rejects_out_of_range(client, monkeypatch, qs):
    fake = FakeGateway({"logs.tail": TAIL}).install(monkeypatch)
    r = client.get(f"/api/logs/tail?{qs}")
    assert r.status_code == 400 and r.json()["error"] == "bad_request"
    assert fake.calls == []


def test_tail_gateway_failure(client, monkeypatch):
    FakeGateway({"logs.tail": TimeoutError()}).install(monkeypatch)
    r = client.get("/api/logs/tail")
    assert r.status_code == 502 and r.json()["error"] == "gateway_unreachable"


def test_tail_handles_non_dict_payload(client, monkeypatch):
    FakeGateway({"logs.tail": ["not", "a", "dict"]}).install(monkeypatch)
    r = client.get("/api/logs/tail")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["lines"] == [] and body["file"] is None
    assert body["truncated"] is False and body["reset"] is False
