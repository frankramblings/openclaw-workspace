"""projects.json store (spec §4.2) + sessions_store.unfile_project."""
import json

import pytest

from backend import config, projects_store, sessions_store


@pytest.fixture(autouse=True)
def _store(tmp_path, monkeypatch):
    monkeypatch.setattr(projects_store, "_STORE_FILE", tmp_path / "projects.json")


def test_create_list_get_shape():
    p = projects_store.create("Local AI", hints=["kamino", "mlx"])
    assert p["id"].startswith("p-") and len(p["id"]) == 10
    assert p["name"] == "Local AI" and p["archived"] is False and p["hints"] == ["kamino", "mlx"]
    assert isinstance(p["created"], int) and p["updated"] == p["created"]
    assert projects_store.get(p["id"]) == p
    assert projects_store.list_projects() == [p]


def test_duplicate_names_are_case_insensitive_and_trimmed():
    projects_store.create("Plex")
    with pytest.raises(ValueError, match="duplicate"):
        projects_store.create("  plex ")
    with pytest.raises(ValueError, match="empty"):
        projects_store.create("   ")
    assert projects_store.find_by_name("PLEX")["name"] == "Plex"
    assert projects_store.find_by_name("nope") is None


def test_update_rename_archive_and_duplicate_guard():
    a = projects_store.create("A")
    projects_store.create("B")
    out = projects_store.update(a["id"], name="A2", archived=True)
    assert out["name"] == "A2" and out["archived"] is True and out["updated"] >= a["updated"]
    with pytest.raises(ValueError, match="duplicate"):
        projects_store.update(a["id"], name="b")
    assert projects_store.update(a["id"], name="A2") is not None, "renaming to your own name is fine"
    assert projects_store.update("p-missing", name="x") is None
    assert projects_store.update(a["id"], bogus=1)["name"] == "A2"


def test_list_orders_by_updated_desc():
    a = projects_store.create("A")
    b = projects_store.create("B")
    projects_store.update(a["id"], hints=["x"])
    assert [p["id"] for p in projects_store.list_projects()] == [a["id"], b["id"]]


def test_delete_and_unfile():
    p = projects_store.create("Gone")
    s1 = sessions_store.create(name="s1", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    s2 = sessions_store.create(name="s2", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    sessions_store.update(s1["id"], folder=p["id"])
    sessions_store.update(s2["id"], folder="p-other")
    assert sessions_store.unfile_project(p["id"]) == 1
    assert sessions_store.get(s1["id"])["folder"] is None
    assert sessions_store.get(s2["id"])["folder"] == "p-other"
    assert projects_store.delete(p["id"]) is True
    assert projects_store.delete(p["id"]) is False


def test_missing_or_corrupt_file_reads_as_empty(tmp_path, monkeypatch):
    f = tmp_path / "projects.json"
    monkeypatch.setattr(projects_store, "_STORE_FILE", f)
    assert projects_store.list_projects() == []
    f.write_text("{not json")
    assert projects_store.list_projects() == []
    projects_store.create("Fresh")
    assert json.loads(f.read_text())["schema_version"] == 1
