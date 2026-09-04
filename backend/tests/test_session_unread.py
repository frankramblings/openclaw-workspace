"""Manual "Mark unread" flag: POST /api/session/{id}/unread stores a boolean on
the session record, GET /api/sessions hands it back, and an unrelated PATCH does
not clear it."""
import tempfile

import pytest
from fastapi.testclient import TestClient

from backend import branch_context, config, sessions_store
from backend.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", tmp)
    branch_context  # imported for the env override above


def _mk(**kw):
    base = dict(name="t", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    base.update(kw)
    return sessions_store.create(**base)


def test_set_and_clear_unread():
    rec = _mk()
    r = client.post(f"/api/session/{rec['id']}/unread")
    assert r.status_code == 200 and r.json() == {"ok": True, "unread": True}
    assert sessions_store.get(rec["id"])["unread"] is True

    r = client.post(f"/api/session/{rec['id']}/unread", data={"unread": "false"})
    assert r.status_code == 200 and r.json() == {"ok": True, "unread": False}
    assert sessions_store.get(rec["id"])["unread"] is False


def test_sessions_list_includes_unread():
    rec = _mk()
    client.post(f"/api/session/{rec['id']}/unread", data={"unread": "true"})
    rows = client.get("/api/sessions").json()
    row = next(s for s in rows if s["id"] == rec["id"])
    assert row["unread"] is True


def test_unknown_id_mirrors_important_route():
    imp = client.post("/api/session/nope/important")
    unr = client.post("/api/session/nope/unread")
    assert unr.status_code == imp.status_code
    assert unr.json() == {"ok": True, "unread": True}


def test_patch_does_not_clear_unread():
    rec = _mk()
    client.post(f"/api/session/{rec['id']}/unread")
    r = client.patch(f"/api/session/{rec['id']}", data={"name": "renamed"})
    assert r.status_code == 200
    stored = sessions_store.get(rec["id"])
    assert stored["name"] == "renamed"
    assert stored["unread"] is True
