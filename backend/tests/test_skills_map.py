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


def test_workspace_skill_create_edit_and_delete(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend import skills
    from backend.app import app

    monkeypatch.setattr(skills, "SKILLS_ROOT", tmp_path)
    monkeypatch.setattr(skills, "_by_name", {})
    client = TestClient(app)

    created = client.post("/api/skills/add", json={
        "name": "test-skill",
        "description": "Use for a focused test.",
        "when_to_use": "When verifying skill CRUD.",
        "procedure": ["Run it", "Check it"],
        "tags": ["test"],
    })
    assert created.status_code == 200
    path = tmp_path / "test-skill" / "SKILL.md"
    assert "name: test-skill" in path.read_text()

    monkeypatch.setitem(skills._by_name, "test-skill", {"filePath": str(path)})
    edited = client.post("/api/skills/test-skill/markdown", json={"markdown": "# Replaced\n"})
    assert edited.status_code == 200
    assert path.read_text() == "# Replaced\n"

    deleted = client.delete("/api/skills/test-skill")
    assert deleted.status_code == 200
    assert not path.exists()


def test_bundled_skill_mutations_are_blocked(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from backend import skills
    from backend.app import app

    root = tmp_path / "workspace"
    bundled = tmp_path / "plugin" / "SKILL.md"
    bundled.parent.mkdir()
    bundled.write_text("bundled")
    monkeypatch.setattr(skills, "SKILLS_ROOT", root)
    monkeypatch.setattr(skills, "_by_name", {"bundled": {"filePath": str(bundled)}})
    client = TestClient(app)

    assert client.post("/api/skills/bundled/markdown", json={"markdown": "bad"}).status_code == 403
    assert client.delete("/api/skills/bundled").status_code == 403
    assert bundled.read_text() == "bundled"
