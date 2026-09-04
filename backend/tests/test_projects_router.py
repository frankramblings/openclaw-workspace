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
