"""The amber card must survive a reload: warnings are the one enforcement
signal that lived only in the volatile event stream (live-fire 2026-07-10:
Frank opened the thread after the turn and the card was gone)."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import promise_guard


@pytest.fixture
def client():
    return TestClient(app_module.app)


SK = "agent:main:web-abc123def456"


def test_record_and_list_roundtrip(client):
    promise_guard.record_warning(SK, 95, "I'll let you know")
    body = client.get("/api/promise/warnings", params={"session": SK}).json()
    assert body["warnings"][-1]["turn_id"] == 95
    assert body["warnings"][-1]["phrase"] == "I'll let you know"
    assert isinstance(body["warnings"][-1]["ts"], int)


def test_cap_keeps_newest(client):
    for i in range(promise_guard.WARNINGS_CAP + 5):
        promise_guard.record_warning(SK, i, f"p{i}")
    body = client.get("/api/promise/warnings", params={"session": SK}).json()
    assert len(body["warnings"]) == promise_guard.WARNINGS_CAP
    assert body["warnings"][-1]["turn_id"] == promise_guard.WARNINGS_CAP + 4


def test_unknown_session_is_empty(client):
    assert client.get("/api/promise/warnings",
                      params={"session": "nope"}).json() == {"warnings": []}


def test_record_never_raises(monkeypatch):
    monkeypatch.setattr(promise_guard.fsutil, "atomic_write_json",
                        lambda *a, **k: (_ for _ in ()).throw(OSError("disk full")))
    promise_guard.record_warning(SK, 1, "x")   # must not raise


def test_drop_session_clears_warnings(client):
    promise_guard.record_warning(SK, 1, "x")
    promise_guard.drop_session(SK)
    assert client.get("/api/promise/warnings", params={"session": SK}).json() == {"warnings": []}
