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
    # C1 / spec 4.2 amendment: filing is bookkeeping, not activity -- writing
    # `folder` must not bump `updated`. _now_ms is faked to distinct,
    # increasing values so "updated is unchanged" can't pass by accident on
    # two calls landing in the same millisecond (see
    # test_projects_store.py::test_delete_and_unfile).
    times = iter(range(1000, 11000, 1000))
    monkeypatch.setattr(sessions_store, "_now_ms", lambda: next(times))
    p = projects_store.create("Plex", hints=["plex"])
    rec = _sess("Plex down again")
    before = sessions_store.get(rec["id"])["updated"]
    calls = {}

    async def fake_complete(model_ref, prompt, **kw):
        calls["prompt"] = prompt
        calls["kw"] = kw
        return p["id"]

    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    assert await project_classify.file_session(rec["id"], "plex is down") == p["id"]
    assert sessions_store.get(rec["id"])["folder"] == p["id"]
    assert sessions_store.get(rec["id"])["updated"] == before, "filing must not bump updated"
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
    # C1 / spec 4.2 amendment: backfill's writes are bookkeeping, not
    # activity -- filing must not bump `updated` (that would reverse row
    # order inside a project, since list_sessions iterates created-desc and
    # the oldest filed session would get the newest stamp). _now_ms is faked
    # to distinct, increasing values so this can't pass by accident on two
    # calls landing in the same millisecond (see
    # test_projects_store.py::test_delete_and_unfile). Based on the real
    # clock (unlike that test's tiny fixed values) because backfill's
    # since_days window is computed from real time.time() -- a fake base of
    # 1000ms would put every session outside a 90-day window.
    import time as _time
    base = int(_time.time() * 1000)
    times = iter(base + i * 1000 for i in range(50))
    monkeypatch.setattr(sessions_store, "_now_ms", lambda: next(times))
    old = _sess("ancient thing")
    fresh = _sess("Plex whisper server setup")
    filed = _sess("Kamino models", folder="p-already")
    arch = _sess("archived one", archived=True)
    before = sessions_store.get(fresh["id"])["updated"]
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
    assert sessions_store.get(fresh["id"])["updated"] == before, "backfill filing must not bump updated"
    assert sessions_store.get(filed["id"])["folder"] == "p-already"
    assert sessions_store.get(arch["id"])["folder"] is None
    assert sessions_store.get(old["id"])["folder"] is None
    assert len(seen) == 1
    assert projects_store.find_by_name("Wedding")["archived"] is True


@pytest.mark.anyio
async def test_backfill_aborts_after_three_consecutive_model_failures(monkeypatch):
    # I5: local_llm.complete returns "" on any transport/model failure and
    # never raises, so a run stuck against a dead local endpoint would
    # otherwise silently plow through every candidate one at a time. Three
    # consecutive empty responses must abort the run instead.
    ids = [_sess(f"thread {i}")["id"] for i in range(5)]
    calls = []

    async def fake_complete(model_ref, prompt, **kw):
        calls.append(kw)
        return ""

    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    out = await project_classify.backfill(since_days=90)
    assert out == {"scanned": 3, "filed": 0, "aborted": "model_failures"}
    assert len(calls) == 3
    # backfill uses a shorter timeout than the title-time hook's default
    assert all(kw.get("timeout") == 15 for kw in calls)
    for sid in ids:
        assert sessions_store.get(sid)["folder"] is None
    # the lock is released even after an abort -- a second call actually runs
    assert project_classify.backfill_running() is False
    out2 = await project_classify.backfill(since_days=90)
    assert out2.get("skipped") != "running"


@pytest.mark.anyio
async def test_backfill_failure_streak_resets_on_a_success(monkeypatch):
    p = projects_store.create("Plex", hints=["plex"])
    for i in range(5):
        _sess(f"s{i}")
    # fail, fail, succeed, fail, fail -- never 3 in a row, so it must not abort
    pattern = ["", "", p["id"], "", ""]
    calls = []

    async def fake_complete(model_ref, prompt, **kw):
        calls.append(1)
        return pattern[len(calls) - 1]

    monkeypatch.setattr(local_llm, "can_route", lambda ref: True)
    monkeypatch.setattr(local_llm, "complete", fake_complete)
    out = await project_classify.backfill(since_days=90)
    assert "aborted" not in out
    assert out["scanned"] == 5 and out["filed"] == 1
    assert len(calls) == 5
