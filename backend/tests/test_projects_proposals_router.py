import pytest
from fastapi.testclient import TestClient

from backend import config, project_classify, project_discovery as pd, projects_store
from backend.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _stores(tmp_path, monkeypatch):
    monkeypatch.setattr(projects_store, "_STORE_FILE", tmp_path / "projects.json")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


def _seed_props():
    pd.save_proposals({"schema_version": 1, "created": 5, "model": "m", "error": None, "proposals": [
        {"id": "d-00000001", "name": "Plex", "hints": ["plex"], "sample_titles": ["a", "b", "c"], "count": 3},
        {"id": "d-00000002", "name": "Wedding", "hints": [], "sample_titles": [], "count": 4}]})


def test_get_proposals_empty_and_populated():
    r = client.get("/api/projects/proposals")
    assert r.status_code == 200 and r.json()["proposals"] == [] and r.json()["running"] is False
    _seed_props()
    r = client.get("/api/projects/proposals")
    assert [p["name"] for p in r.json()["proposals"]] == ["Plex", "Wedding"] and r.json()["created"] == 5


def test_accept_creates_project_removes_proposal_and_backfills(monkeypatch):
    _seed_props()
    calls = []

    async def fake_backfill(since_days=90):
        calls.append(since_days)
        return {"scanned": 0, "filed": 0}
    monkeypatch.setattr(project_classify, "backfill", fake_backfill)
    r = client.post("/api/projects/proposals/d-00000001/accept")
    assert r.status_code == 201 and r.json()["name"] == "Plex" and r.json()["hints"] == ["plex"]
    assert [p["name"] for p in projects_store.list_projects()] == ["Plex"]
    assert [p["id"] for p in pd.load_proposals()["proposals"]] == ["d-00000002"]
    assert calls == [90]
    assert client.post("/api/projects/proposals/d-00000001/accept").status_code == 404


def test_accept_duplicate_name_is_409_and_drops_proposal():
    _seed_props()
    projects_store.create("plex")
    r = client.post("/api/projects/proposals/d-00000001/accept")
    assert r.status_code == 409
    assert [p["id"] for p in pd.load_proposals()["proposals"]] == ["d-00000002"]


def test_dismiss():
    _seed_props()
    assert client.post("/api/projects/proposals/d-00000002/dismiss").json() == {"ok": True}
    assert [p["id"] for p in pd.load_proposals()["proposals"]] == ["d-00000001"]
    assert client.post("/api/projects/proposals/d-00000002/dismiss").status_code == 404


def test_discover_starts_and_refuses_while_running(monkeypatch):
    started = []

    async def fake_discover(since_days=90):
        started.append(1)
        return pd.load_proposals()
    monkeypatch.setattr(pd, "discover", fake_discover)
    assert client.post("/api/projects/discover").json() == {"status": "started"}
    monkeypatch.setattr(pd, "running", lambda: True)
    assert client.post("/api/projects/discover").status_code == 409
