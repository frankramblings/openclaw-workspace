import json

from backend import config, project_classify, projects_store


def _seed_path():
    return config.DATA_DIR / project_classify.SEED_FILE_NAME


def test_no_seed_file_seeds_nothing():
    assert project_classify.load_seeds() == []
    assert project_classify.seed_if_empty() == 0
    assert projects_store.list_projects() == []


def test_seed_file_is_applied_once():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    _seed_path().write_text(json.dumps({"schema_version": 1, "projects": [
        {"name": "Alpha", "archived": False, "hints": ["a"]},
        {"name": "Beta", "archived": True, "hints": []},
        {"name": "alpha", "archived": False, "hints": ["dup"]},
    ]}))
    assert project_classify.seed_if_empty() == 2
    names = sorted(p["name"] for p in projects_store.list_projects())
    assert names == ["Alpha", "Beta"]
    assert project_classify.seed_if_empty() == 0


def test_malformed_seed_file_seeds_nothing(caplog):
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    _seed_path().write_text("{not json")
    assert project_classify.load_seeds() == []
    _seed_path().write_text(json.dumps({"projects": "nope"}))
    assert project_classify.load_seeds() == []
    _seed_path().write_text(json.dumps({"projects": [{"hints": ["x"]}, 7, {"name": " "}]}))
    assert project_classify.load_seeds() == []
    assert project_classify.seed_if_empty() == 0
