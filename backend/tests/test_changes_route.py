import pytest
from fastapi.testclient import TestClient

from backend import changes, sessions_store
from backend.app import app


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def sess():
    rec = sessions_store.create(name="s", model="claude-opus-4-8", endpoint_id="claude-cli")
    yield rec
    sessions_store.delete(rec["id"])


def test_turn_session_diff_revert(client, sess, monkeypatch):
    sk = sess["sessionKey"]
    rec = {"session_key": sk, "turn_id": 3, "started_ms": 1, "ended_ms": 2, "shared_with": [],
           "files": [{"path": "a.md", "root": "/r", "kind": "modified", "diffable": True, "added": 1, "removed": 0,
                      "before_sha": "x", "after_sha": "y", "before_bytes": 1, "after_bytes": 2, "shared": False, "reverted": False}]}
    monkeypatch.setattr(changes, "turn_record", lambda k, t: rec if (k, t) == (sk, 3) else None)
    monkeypatch.setattr(changes, "session_turns", lambda k: [{"turn_id": 3, "files": 1}] if k == sk else [])
    monkeypatch.setattr(changes, "diff_for", lambda k, t, p: {"diffable": True, "text": "--- a/a.md\n+++ b/a.md\n", "before_bytes": 1, "after_bytes": 2, "kind": "modified"})
    calls = []
    monkeypatch.setattr(changes, "revert", lambda k, t, p: calls.append((k, t, p)) or (True, "ok"))

    r = client.get(f"/api/changes/turn?session={sess['id']}&turn=3")
    assert r.status_code == 200 and r.json()["record"]["files"][0]["path"] == "a.md"
    assert client.get(f"/api/changes/turn?session={sess['id']}&turn=4").status_code == 404
    assert client.get(f"/api/changes/session?session={sess['id']}").json()["turns"][0]["turn_id"] == 3
    d = client.get(f"/api/changes/diff?session={sess['id']}&turn=3&path=a.md").json()
    assert d["ok"] is True and d["text"].startswith("--- a/a.md")
    r = client.post("/api/changes/revert", json={"session": sess["id"], "turn": 3, "path": "a.md"})
    assert r.status_code == 200 and calls == [(sk, 3, "a.md")]


def test_revert_conflict_and_missing(client, sess, monkeypatch):
    monkeypatch.setattr(changes, "revert", lambda k, t, p: (False, "file_changed_since"))
    r = client.post("/api/changes/revert", json={"session": sess["id"], "turn": 3, "path": "a.md"})
    assert r.status_code == 409 and r.json()["reason"] == "file_changed_since"
    monkeypatch.setattr(changes, "revert", lambda k, t, p: (False, "not_found"))
    assert client.post("/api/changes/revert", json={"session": sess["id"], "turn": 3, "path": "a.md"}).status_code == 404


def test_config_validation(client, tmp_path):
    ok = client.put("/api/changes/config", json={"roots": [str(tmp_path)], "max_bytes": 4096})
    assert ok.status_code == 200 and ok.json()["config"]["roots"] == [str(tmp_path)]
    assert client.put("/api/changes/config", json={"roots": ["relative/path"]}).status_code == 400
    assert client.put("/api/changes/config", json={"max_bytes": 10}).status_code == 400
    assert client.get("/api/changes/config").json()["config"]["max_bytes"] == 4096


def test_stats_and_rebuild(client, monkeypatch):
    monkeypatch.setattr(changes, "stats", lambda: {"blobs": 0, "blob_bytes": 0, "roots": [], "rebuild": {"running": False, "root": None}})
    assert client.get("/api/changes/stats").json()["blobs"] == 0
    monkeypatch.setattr(changes, "rebuild", lambda: {"roots": 0, "files": 0})
    assert client.post("/api/changes/rebuild").json() == {"ok": True, "roots": 0, "files": 0}
    monkeypatch.setattr(changes, "rebuild", lambda: {"busy": True})
    assert client.post("/api/changes/rebuild").status_code == 409
