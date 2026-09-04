"""backend.notes: POST /api/notes accepts `body` as an alias for `content`
(the mobile quick-capture bug, spec 1.3/12: mobile-app.js used to post
`body` while notes.py only ever read `content`, so every quick-capture note
saved with an empty body -- ground-truth audit, backend/notes.py:133,
frontend-overrides/js/redesign/mobile/mobile-app.js:233). No test file
existed for notes.py before this one."""
import pytest
from fastapi.testclient import TestClient

from backend import notes
from backend.app import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setattr(notes, "NOTES_DIR", tmp_path / "Notes")
    return TestClient(app)


def test_post_notes_accepts_body_alias(client):
    r = client.post("/api/notes", json={"title": "Capture", "body": "captured text", "kind": "remind"})
    assert r.status_code == 200
    data = r.json()
    assert data["content"] == "captured text"
    listed = client.get("/api/notes").json()["notes"]
    saved = next(n for n in listed if n["id"] == data["id"])
    assert saved["content"] == "captured text"


def test_post_notes_content_wins_over_body_when_both_present(client):
    r = client.post("/api/notes", json={"title": "X", "content": "real", "body": "ignored"})
    assert r.status_code == 200
    assert r.json()["content"] == "real"


def test_post_notes_without_body_or_content_is_still_empty(client):
    r = client.post("/api/notes", json={"title": "No body"})
    assert r.status_code == 200
    assert r.json()["content"] == ""


def test_notes_crud_round_trip(client):
    r = client.post("/api/notes", json={"title": "Round Trip", "content": "v1"})
    assert r.status_code == 200
    note = r.json()
    nid = note["id"]
    assert note["content"] == "v1"

    listed = client.get("/api/notes").json()["notes"]
    assert any(n["id"] == nid for n in listed)

    r2 = client.put(f"/api/notes/{nid}", json={"content": "v2", "title": "Round Trip 2"})
    assert r2.status_code == 200
    assert r2.json()["content"] == "v2"
    assert r2.json()["title"] == "Round Trip 2"

    r3 = client.delete(f"/api/notes/{nid}")
    assert r3.status_code == 200
    assert r3.json()["ok"] is True

    listed_after = client.get("/api/notes").json()["notes"]
    assert not any(n["id"] == nid for n in listed_after)
