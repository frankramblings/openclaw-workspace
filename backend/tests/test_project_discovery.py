import json
import time

import pytest

from backend import config, local_llm, project_discovery as pd, projects_store, sessions_store


@pytest.fixture
def anyio_backend():
    return "asyncio"


def _mk(n, prefix="Plex", days_ago=1):
    for i in range(n):
        s = sessions_store.create(name=f"{prefix} question {i}", model=None, endpoint_url=None,
                                  endpoint_id=None, speed=None)
        data = sessions_store._load()
        for rec in data["sessions"]:
            if rec["id"] == s["id"]:
                rec["updated"] = int((time.time() - days_ago * 86400) * 1000)
        sessions_store._save(data)


def test_should_discover_gates():
    assert pd.should_discover() is False          # no sessions
    _mk(12)
    assert pd.should_discover() is True
    projects_store.create("Anything")
    assert pd.should_discover() is False          # store not empty


def test_should_discover_false_with_seed_or_proposal_file():
    _mk(12)
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    (config.DATA_DIR / "projects_seed.json").write_text(json.dumps({"projects": []}))
    assert pd.should_discover() is False
    (config.DATA_DIR / "projects_seed.json").unlink()
    pd.save_proposals({"schema_version": 1, "created": 1, "model": "m", "proposals": [], "error": None})
    assert pd.should_discover() is False


def test_parse_proposals_filters_and_caps():
    titles = [f"Plex setup {i}" for i in range(4)] + ["Wedding cake", "Wedding toast", "Wedding planner"] + ["Misc"]
    raw = "```json\n" + json.dumps({"projects": [
        {"name": "Plex", "hints": ["plex", "PLEX", "media"], "titles": ["Plex setup 0", "Plex setup 1", "Plex setup 2"]},
        {"name": "Wedding", "hints": ["wedding"], "titles": ["Wedding cake", "Wedding toast", "Wedding planner"]},
        {"name": "plex", "hints": ["dup"], "titles": ["Plex setup 3", "Plex setup 1", "Plex setup 2"]},
        {"name": "Too small", "hints": ["x"], "titles": ["Misc"]},
        {"name": "Hallucinated", "hints": ["y"], "titles": ["not a title", "nor this", "nor that"]},
        {"name": "x" * 80, "hints": ["long"], "titles": ["Plex setup 0", "Plex setup 1", "Plex setup 2"]},
    ]}) + "\n```"
    out = pd.parse_proposals(raw, titles)
    names = [p["name"] for p in out]
    assert names[:2] == ["Plex", "Wedding"]
    assert "Too small" not in names and "Hallucinated" not in names
    assert all(len(p["name"]) <= 40 for p in out)
    assert out[0]["hints"] == ["plex", "media"]
    assert out[0]["count"] == 3 and out[0]["sample_titles"] == ["Plex setup 0", "Plex setup 1", "Plex setup 2"]
    assert out[0]["id"].startswith("d-") and len(out[0]["id"]) == 10


def test_parse_proposals_garbage():
    assert pd.parse_proposals("", ["a"]) == []
    assert pd.parse_proposals("no json here", ["a"]) == []
    assert pd.parse_proposals('{"projects": "nope"}', ["a"]) == []


@pytest.mark.anyio
async def test_discover_writes_proposals_and_creates_no_projects(monkeypatch):
    _mk(6, "Plex")
    _mk(6, "Wedding")
    monkeypatch.setattr(config, "PROJECT_CLASSIFY_ENABLED", True)
    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    seen = {}

    async def fake_complete(model_ref, prompt, **kw):
        seen["prompt"] = prompt
        return json.dumps({"projects": [
            {"name": "Plex", "hints": ["plex"], "titles": [f"Plex question {i}" for i in range(4)]},
        ]})
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    res = await pd.discover()
    assert res["error"] is None and [p["name"] for p in res["proposals"]] == ["Plex"]
    assert "Plex question 0" in seen["prompt"] and "Wedding question 0" in seen["prompt"]
    assert projects_store.list_projects() == []
    on_disk = pd.load_proposals()
    assert on_disk["proposals"][0]["name"] == "Plex" and on_disk["model"] == config.TITLE_MODEL
    assert pd.should_discover() is False


@pytest.mark.anyio
async def test_discover_records_model_failure(monkeypatch):
    _mk(12)
    monkeypatch.setattr(config, "PROJECT_CLASSIFY_ENABLED", True)
    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)

    async def dead(model_ref, prompt, **kw):
        return ""
    monkeypatch.setattr(local_llm, "complete", dead)
    res = await pd.discover()
    assert res["proposals"] == [] and res["error"] == "model_failed"
    assert pd.load_proposals()["error"] == "model_failed"


@pytest.mark.anyio
async def test_discover_skips_existing_project_names(monkeypatch):
    _mk(12)
    projects_store.create("Plex")
    monkeypatch.setattr(config, "PROJECT_CLASSIFY_ENABLED", True)
    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)

    async def fake_complete(model_ref, prompt, **kw):
        return json.dumps({"projects": [{"name": "plex", "hints": ["p"], "titles": [f"Plex question {i}" for i in range(3)]}]})
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    res = await pd.discover()
    assert res["proposals"] == []


def test_remove_proposal():
    pd.save_proposals({"schema_version": 1, "created": 1, "model": "m", "error": None, "proposals": [
        {"id": "d-00000001", "name": "A", "hints": [], "sample_titles": [], "count": 3},
        {"id": "d-00000002", "name": "B", "hints": [], "sample_titles": [], "count": 3}]})
    gone = pd.remove_proposal("d-00000001")
    assert gone["name"] == "A"
    assert [p["id"] for p in pd.load_proposals()["proposals"]] == ["d-00000002"]
    assert pd.remove_proposal("d-nope") is None


@pytest.mark.anyio
async def test_discover_while_running_returns_current_file(monkeypatch):
    pd.save_proposals({"schema_version": 1, "created": 1, "model": "m", "error": None, "proposals": [
        {"id": "d-00000001", "name": "A", "hints": [], "sample_titles": [], "count": 3}]})

    async def must_not_be_called(model_ref, prompt, **kw):
        pytest.fail("local_llm.complete should not be called while discover() is already running")
    monkeypatch.setattr(local_llm, "complete", must_not_be_called)

    async with pd._LOCK:
        assert pd.running() is True
        assert await pd.discover() == pd.load_proposals()
    assert pd.running() is False
