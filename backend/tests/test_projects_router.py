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
    ran = {}

    async def fake_backfill(since_days=90):
        ran["since"] = since_days
        return {"scanned": 0, "filed": 0}

    monkeypatch.setattr(project_classify, "backfill", fake_backfill)
    r = client.post("/api/projects/backfill", json={"since_days": 30})
    assert r.status_code == 200 and r.json() == {"status": "started"}
    assert ran == {"since": 30}
    monkeypatch.setattr(project_classify, "backfill_running", lambda: True)
    assert client.post("/api/projects/backfill", json={}).json() == {"status": "running"}


def test_patch_session_folder_set_and_unfile(monkeypatch):
    # Unfiling is bookkeeping, not activity (matches unfile_project): _now_ms
    # is faked to distinct, increasing values so "updated is unchanged" can't
    # pass by accident on two calls landing in the same millisecond.
    times = iter([1000, 2000, 3000, 4000, 5000])
    monkeypatch.setattr(sessions_store, "_now_ms", lambda: next(times))
    s = sessions_store.create(name="s", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    assert client.patch(f"/api/session/{s['id']}", data={"folder": "p-12345678"}).json()["folder"] == "p-12345678"
    before = sessions_store.get(s["id"])["updated"]
    assert client.post(f"/api/session/{s['id']}/unfile").json()["folder"] is None
    assert sessions_store.get(s["id"])["updated"] == before
    assert client.post("/api/session/nope/unfile").status_code == 404
