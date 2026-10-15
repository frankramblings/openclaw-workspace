import json

import pytest
from fastapi.testclient import TestClient

from backend import config, project_classify, projects_store, sessions_store
from backend import projects as projects_router
from backend.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _stores(tmp_path, monkeypatch):
    monkeypatch.setattr(projects_store, "_STORE_FILE", tmp_path / "projects.json")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


def test_crud():
    r = client.post("/api/projects", json={"name": "Local AI"})
    assert r.status_code == 201
    pid = r.json()["id"]
    assert client.post("/api/projects", json={"name": "local ai"}).status_code == 409
    assert client.post("/api/projects", json={"name": "  "}).status_code == 400
    assert [p["id"] for p in client.get("/api/projects").json()] == [pid]
    r = client.patch(f"/api/projects/{pid}", json={"name": "Local AI 2", "archived": True})
    assert r.status_code == 200 and r.json()["archived"] is True and r.json()["name"] == "Local AI 2"
    assert client.patch("/api/projects/p-missing", json={"name": "x"}).status_code == 404
    client.post("/api/projects", json={"name": "Other"})
    assert client.patch(f"/api/projects/{pid}", json={"name": "other"}).status_code == 409


def test_delete_unfiles_sessions():
    pid = client.post("/api/projects", json={"name": "Gone"}).json()["id"]
    s = sessions_store.create(name="s", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    sessions_store.update(s["id"], folder=pid)
    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 200 and r.json() == {"ok": True, "unfiled": 1}
    assert sessions_store.get(s["id"])["folder"] is None
    assert client.delete(f"/api/projects/{pid}").status_code == 404


def test_backfill_starts_background_task(monkeypatch):
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    seed_path = config.DATA_DIR / project_classify.SEED_FILE_NAME
    seed_path.write_text(json.dumps({"schema_version": 1, "projects": [
        {"name": "Alpha", "archived": False, "hints": []},
        {"name": "Beta", "archived": True, "hints": []},
    ]}))
    ran = {}

    async def fake_backfill(since_days=90):
        ran["since"] = since_days
        return {"scanned": 0, "filed": 0}

    monkeypatch.setattr(project_classify, "backfill", fake_backfill)
    r = client.post("/api/projects/backfill", json={"since_days": 30})
    assert r.status_code == 200 and r.json() == {"status": "started"}
    assert ran == {"since": 30}
    # I4: the route seeds synchronously (not inside the -- here faked --
    # background backfill), so the sidebar has the seed file's projects to
    # show the instant "Re-run backfill" returns, without waiting on the model.
    projects = client.get("/api/projects").json()
    assert len(projects) == 2
    assert next(p for p in projects if p["name"] == "Beta")["archived"] is True
    monkeypatch.setattr(project_classify, "backfill_running", lambda: True)
    assert client.post("/api/projects/backfill", json={}).json() == {"status": "running"}


def test_patch_session_folder_set_and_unfile(monkeypatch):
    # Filing/unfiling is bookkeeping, not activity (spec 4.2 amendment,
    # matches unfile_project): _now_ms is faked to distinct, increasing
    # values so "updated is unchanged" can't pass by accident on two calls
    # landing in the same millisecond.
    times = iter([1000, 2000, 3000, 4000, 5000, 6000])
    monkeypatch.setattr(sessions_store, "_now_ms", lambda: next(times))
    s = sessions_store.create(name="s", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    before = sessions_store.get(s["id"])["updated"]
    assert client.patch(f"/api/session/{s['id']}", data={"folder": "p-12345678"}).json()["folder"] == "p-12345678"
    assert sessions_store.get(s["id"])["updated"] == before, "a folder-only PATCH must not bump updated"
    assert client.post(f"/api/session/{s['id']}/unfile").json()["folder"] is None
    assert sessions_store.get(s["id"])["updated"] == before, "unfile must not bump updated either"
    assert client.post("/api/session/nope/unfile").status_code == 404
    assert client.patch(f"/api/session/{s['id']}", data={"name": "renamed"}).json()["name"] == "renamed"
    assert sessions_store.get(s["id"])["updated"] != before, "a PATCH touching a non-folder field still bumps updated"


def test_create_and_patch_hints_are_normalized():
    r = client.post("/api/projects", json={"name": "Beatles", "hints": [" Beatles ", "", "Rubber Soul", "beatles"]})
    assert r.status_code == 201
    assert r.json()["hints"] == ["beatles", "rubber soul"]
    pid = r.json()["id"]
    r = client.patch(f"/api/projects/{pid}", json={"hints": ["Abbey Road", " ", "abbey road"]})
    assert r.status_code == 200 and r.json()["hints"] == ["abbey road"]
    assert client.patch(f"/api/projects/{pid}", json={"hints": "nope"}).status_code == 400


def test_merge_moves_threads_and_hints_then_removes_source():
    a = client.post("/api/projects", json={"name": "A", "hints": ["x"]}).json()["id"]
    b = client.post("/api/projects", json={"name": "B", "hints": ["y", "x"]}).json()["id"]
    s = sessions_store.create(name="s", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    sessions_store.update(s["id"], folder=a)
    r = client.post(f"/api/projects/{a}/merge", json={"into": b})
    assert r.status_code == 200 and r.json()["moved"] == 1
    assert sessions_store.get(s["id"])["folder"] == b
    assert projects_store.get(a) is None
    assert projects_store.get(b)["hints"] == ["y", "x"]
    assert client.post(f"/api/projects/{b}/merge", json={"into": b}).status_code == 400
    assert client.post(f"/api/projects/{b}/merge", json={"into": "p-missing"}).status_code == 404
    assert client.post("/api/projects/p-missing/merge", json={"into": b}).status_code == 404


def test_bulk_move_files_and_unfiles_without_touching_updated():
    pid = client.post("/api/projects", json={"name": "Dest"}).json()["id"]
    s1 = sessions_store.create(name="1", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    s2 = sessions_store.create(name="2", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    before = sessions_store.get(s1["id"])["updated"]
    r = client.post("/api/projects/move-threads", json={"ids": [s1["id"], s2["id"], "missing"], "project_id": pid})
    assert r.status_code == 200 and r.json() == {"moved": 2}
    assert sessions_store.get(s1["id"])["folder"] == pid
    assert sessions_store.get(s1["id"])["updated"] == before
    r = client.post("/api/projects/move-threads", json={"ids": [s1["id"]], "project_id": None})
    assert r.json() == {"moved": 1} and sessions_store.get(s1["id"])["folder"] is None
    assert client.post("/api/projects/move-threads", json={"ids": [s1["id"]], "project_id": "p-missing"}).status_code == 404
    assert client.post("/api/projects/move-threads", json={"ids": "bad", "project_id": pid}).status_code == 400
