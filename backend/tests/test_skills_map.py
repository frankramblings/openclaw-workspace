"""Unit tests for the skills mapper."""
from backend.skills import _map_skill


def test_map_skill_exposes_enabled():
    assert _map_skill({"name": "a"})["enabled"] is True
    assert _map_skill({"name": "a", "disabled": True})["enabled"] is False


def test_unknown_skill_404(monkeypatch):
    from fastapi.testclient import TestClient

    from backend import skills
    from backend.app import app

    monkeypatch.setattr(skills, "_by_name", {"real": {"skillKey": "real"}})

    async def _no_refresh():
        return []
    monkeypatch.setattr(skills, "fetch_skills", _no_refresh)

    client = TestClient(app)
    res = client.post("/api/skills/bogus/enabled", json={"enabled": False})
    assert res.status_code == 404
