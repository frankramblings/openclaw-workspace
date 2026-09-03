"""Auto-filer (spec §6): strict pick-one-or-none prompt on the local title
model, never raising into a turn; seeded backfill over titles."""
import pytest

from backend import config, local_llm, project_classify, projects_store, sessions_store


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _stores(tmp_path, monkeypatch):
    monkeypatch.setattr(projects_store, "_STORE_FILE", tmp_path / "projects.json")
    monkeypatch.setattr(config, "PROJECT_CLASSIFY_ENABLED", True)


def _sess(name, **kw):
    rec = sessions_store.create(name=name, model=None, endpoint_url=None, endpoint_id=None, speed=None)
    if kw:
        sessions_store.update(rec["id"], **kw)
    return sessions_store.get(rec["id"])


def test_seed_if_empty_creates_the_final_list_once():
    n = project_classify.seed_if_empty()
    names = {p["name"]: p for p in projects_store.list_projects()}
    assert n == len(project_classify.SEEDS) == 11
    assert names["Wedding"]["archived"] is True
    assert names["Social strategy"]["archived"] is False
    assert "hootsuite" in names["Social strategy"]["hints"]
    assert project_classify.seed_if_empty() == 0


def test_prompt_lists_only_active_projects_with_hints():
    a = projects_store.create("Local AI", hints=["kamino"])
    projects_store.create("Wedding", archived=True)
    prompt = project_classify.build_prompt("Kamino oMLX", "how do I run oMLX", project_classify.candidates())
    assert a["id"] in prompt and "Local AI" in prompt and "kamino" in prompt
    assert "Wedding" not in prompt
    assert "none" in prompt.lower()
    assert "Kamino oMLX" in prompt


def test_parse_choice():
    ids = {"p-aaaaaaaa", "p-bbbbbbbb"}
    assert project_classify.parse_choice("p-aaaaaaaa", ids) == "p-aaaaaaaa"
    assert project_classify.parse_choice("  P-BBBBBBBB \n", ids) == "p-bbbbbbbb"
    assert project_classify.parse_choice("Answer: p-aaaaaaaa", ids) == "p-aaaaaaaa"
    assert project_classify.parse_choice("none", ids) is None
    assert project_classify.parse_choice("p-cccccccc", ids) is None
    assert project_classify.parse_choice("", ids) is None
    assert project_classify.parse_choice("p-aaaaaaaa or p-bbbbbbbb", ids) is None, "two answers is no answer"


@pytest.mark.anyio
async def test_classify_skips_when_disabled_no_projects_or_no_local_route(monkeypatch):
    assert await project_classify.classify("t", "m") is None          # no projects
    projects_store.create("X")
    monkeypatch.setattr(local_llm, "can_route", lambda ref: False)
    assert await project_classify.classify("t", "m") is None          # no local route
    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(config, "PROJECT_CLASSIFY_ENABLED", False)
    assert await project_classify.classify("t", "m") is None          # disabled


@pytest.mark.anyio
async def test_file_session_writes_folder_and_skips_filed(monkeypatch):
    p = projects_store.create("Plex", hints=["plex"])
    rec = _sess("Plex down again")
    calls = {}

    async def fake_complete(model_ref, prompt, **kw):
        calls["prompt"] = prompt
        calls["kw"] = kw
        return p["id"]

    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    assert await project_classify.file_session(rec["id"], "plex is down") == p["id"]
    assert sessions_store.get(rec["id"])["folder"] == p["id"]
    assert calls["kw"]["max_tokens"] == 16 and calls["kw"]["temperature"] == 0.0
    assert "Plex down again" in calls["prompt"]
    calls.clear()
    assert await project_classify.file_session(rec["id"], "again") is None, "already filed: skipped"
    assert calls == {}
    assert await project_classify.file_session("nope", "x") is None


@pytest.mark.anyio
async def test_file_session_never_raises(monkeypatch):
    projects_store.create("Plex")
    rec = _sess("boom")

    async def bad(*a, **k):
        raise RuntimeError("model down")

    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(local_llm, "complete", bad)
    assert await project_classify.file_session(rec["id"], "x") is None
    assert sessions_store.get(rec["id"])["folder"] is None


@pytest.mark.anyio
async def test_backfill_seeds_and_files_recent_unfiled_only(monkeypatch):
    old = _sess("ancient thing")
    fresh = _sess("Plex whisper server setup")
    filed = _sess("Kamino models", folder="p-already")
    arch = _sess("archived one", archived=True)
    seen = []

    async def fake_complete(model_ref, prompt, **kw):
        seen.append(prompt)
        plex = projects_store.find_by_name("Plex")
        return plex["id"] if "Plex" in prompt else "none"

    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    # make `old` fall outside the window by rewriting its updated stamp directly
    import json
    data = json.loads(sessions_store._STORE_FILE.read_text())
    for s in data["sessions"]:
        if s["id"] == old["id"]:
            s["updated"] = 1
    sessions_store._STORE_FILE.write_text(json.dumps(data))

    out = await project_classify.backfill(since_days=90)
    assert out["scanned"] == 1 and out["filed"] == 1
    assert sessions_store.get(fresh["id"])["folder"] == projects_store.find_by_name("Plex")["id"]
    assert sessions_store.get(filed["id"])["folder"] == "p-already"
    assert sessions_store.get(arch["id"])["folder"] is None
    assert sessions_store.get(old["id"])["folder"] is None
    assert len(seen) == 1
    assert projects_store.find_by_name("Wedding")["archived"] is True
