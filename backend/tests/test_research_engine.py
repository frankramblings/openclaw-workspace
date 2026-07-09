"""Behavioral tests for the Deep Research engine (`_run`/`_turn`/`_agent_turn`/
`_maybe_compare`) and its 4 HTTP routes (start/stream/status/active).

The gateway seam: research.py never touches websockets/httpx directly — every
agent turn goes through `bridge.stream_turn(message, session_key=..., model_ref=...)`,
an async generator yielding raw SSE strings (see `_agent_turn`). That's the same
seam test_chat_stream_draft.py and test_followup_fire.py fake for the chat/
followup engines, so we mirror it here: monkeypatch `bridge.stream_turn` with a
canned async generator keyed off the prompt text (round prompt vs. report
prompt), and never open a real socket.

Route tests use httpx.AsyncClient(ASGITransport(...)) + @pytest.mark.anyio,
matching test_inbox_undo_router.py. Where a test needs the job to stay
"running" deterministically (not by timing), the fake bridge blocks on an
asyncio.Event that the test releases explicitly — no sleeps, no polling loops.
"""
import asyncio
import json

import pytest
from httpx import ASGITransport, AsyncClient

from backend import bridge, research


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture(autouse=True)
def _isolated_research_dir(tmp_path, monkeypatch):
    """_save_record writes to research.RESEARCH_DIR (module global, computed
    from the real vault at import time) — redirect it so a successful canned
    run never touches ~/.openclaw/workspace/Research, mirroring conftest's
    vault_docs pattern for backend.documents."""
    monkeypatch.setattr(research, "RESEARCH_DIR", tmp_path / "Research")


@pytest.fixture(autouse=True)
def _clean_jobs_registry():
    """_JOBS is a module-global dict shared by every test in the process —
    clear it around each test so leftover jobs from one test can't leak into
    another's /active or /status assertions."""
    research._JOBS.clear()
    yield
    research._JOBS.clear()


FINDINGS = [{"title": "Example", "url": "https://example.com",
            "summary": "concise summary"}]
_REPORT_BODY = "# Title\n\n## Bottom Line\nSolid.\n\n" + ("info " * 100)  # > 400 chars


def _make_fake_stream_turn(gate: asyncio.Event | None = None):
    """A bridge.stream_turn stand-in that branches on the prompt text (the
    round prompt vs. the report prompt carry distinctive fixed strings) and,
    if `gate` is given, blocks after the round's tool_start event until the
    test releases it — a deterministic way to keep a job "running" without
    relying on timing."""
    block = "```json\n" + json.dumps(FINDINGS) + "\n```"

    async def fake(message, session_key=None, model_ref=None, **kwargs):
        if "deep-research job" in message:
            yield bridge._sse({"type": "tool_start", "tool": "web_search",
                               "command": "python news search"})
            yield bridge._sse({"type": "tool_start", "tool": "web_fetch",
                               "command": "https://example.com"})
            if gate is not None:
                await gate.wait()
            yield bridge._sse({"delta": block})
            yield bridge._sse("[DONE]")
        elif "final deep-research report" in message:
            yield bridge._sse({"delta": _REPORT_BODY})
            yield bridge._sse("[DONE]")
        else:  # pragma: no cover - guard against a prompt template change
            raise AssertionError(f"unexpected prompt: {message[:80]!r}")

    return fake


def _sse_frames(text: str) -> list[dict | str]:
    out = []
    for block in text.split("\n\n"):
        if not block.startswith("data:"):
            continue
        body = block[5:].strip()
        try:
            out.append(json.loads(body))
        except ValueError:
            out.append(body)
    return out


# --- _agent_turn: one bridge turn -> full text + tool-event forwarding ------

@pytest.mark.anyio
async def test_agent_turn_streams_deltas_and_forwards_tool_events(monkeypatch):
    async def fake(message, session_key=None, model_ref=None, **kwargs):
        yield bridge._sse({"type": "tool_start", "tool": "web_search", "command": "q"})
        yield bridge._sse({"delta": "Hello "})
        yield bridge._sse({"delta": "world."})
        yield bridge._sse("not-json-marker")   # tolerated, no delta
        yield bridge._sse("[DONE]")

    monkeypatch.setattr(bridge, "stream_turn", fake)
    seen = []
    text = await research._agent_turn("go", "sess1", None, on_event=seen.append)

    assert text == "Hello world."
    # on_event fires for every parsed frame (delta AND tool cards) — _run's
    # closure is what filters to tool_start only; "not-json-marker" fails
    # json.loads and is silently skipped (tolerant SSE parsing).
    assert seen == [{"type": "tool_start", "tool": "web_search", "command": "q"},
                    {"delta": "Hello "}, {"delta": "world."}]


@pytest.mark.anyio
async def test_agent_turn_raises_on_bridge_tool_failure_frame(monkeypatch):
    # The bridge surfaces turn-level failures as a tool_output card for the
    # "bridge"/"agent" pseudo-tools with exit_code 1 — _agent_turn must raise
    # so the caller (_turn -> _run) can mark the job failed.
    async def fake(message, session_key=None, model_ref=None, **kwargs):
        yield bridge._sse({"delta": "partial"})
        yield bridge._sse({"type": "tool_output", "tool": "bridge",
                           "exit_code": 1, "output": "gateway disconnected"})

    monkeypatch.setattr(bridge, "stream_turn", fake)
    with pytest.raises(RuntimeError, match="gateway disconnected"):
        await research._agent_turn("go", "sess1", None)


# --- _run: the full engine loop ---------------------------------------------

@pytest.mark.anyio
async def test_run_happy_path_produces_findings_sources_and_persists_report(monkeypatch):
    monkeypatch.setattr(bridge, "stream_turn", _make_fake_stream_turn())
    job = research.Job(id="happy1", query="python news", settings={})

    await research._run(job)

    assert job.status == "done"
    assert job.findings == FINDINGS
    assert job.sources == [{"title": "Example", "url": "https://example.com"}]
    assert "Solid." in job.result
    assert job.progress["final"] is True and job.progress["phase"] == "done"
    # on_event wiring: one search tool_start -> queries, one read -> sources
    assert job.queries == 1
    assert job.total_sources == 1

    persisted = research._load_record("happy1")
    assert persisted is not None
    assert persisted["query"] == "python news"
    assert persisted["status"] == "done"
    assert persisted["sources"] == job.sources


@pytest.mark.anyio
async def test_run_turn_raises_marks_job_failed_without_crashing(monkeypatch):
    async def raising(message, session_key=None, model_ref=None, **kwargs):
        if False:  # pragma: no cover - keeps this an async generator
            yield
        raise RuntimeError("gateway exploded")

    monkeypatch.setattr(bridge, "stream_turn", raising)
    job = research.Job(id="fail1", query="python news", settings={})

    await research._run(job)  # must not raise — the failure is captured on the job

    assert job.status == "error"
    assert job.progress["final"] is True
    assert "gateway exploded" in job.progress["error"]
    assert research._load_record("fail1") is None   # never reached _save_record


FINDINGS_R1 = [{"title": "Alpha", "url": "https://alpha.example", "summary": "a"}]
FINDINGS_R2 = FINDINGS_R1 + [
    {"title": "Beta", "url": "https://beta.example", "summary": "b"}]


def _rounds_fake(prompts: list, per_round: list):
    """Multi-round bridge.stream_turn stand-in: records every prompt it
    receives and answers the Nth round turn with per_round[N-1] (clamped to
    the last entry, so a clamp test can run more rounds than canned blocks).
    Each round's streamed text MUST contain a parseable findings block —
    otherwise _turn's expect() fails and it falls into the chat.history
    recovery poll, which does real 4-second sleeps."""
    state = {"n": 0}

    async def fake(message, session_key=None, model_ref=None, **kwargs):
        prompts.append(message)
        if "deep-research job" in message:
            state["n"] += 1
            n = min(state["n"], len(per_round))
            block = "```json\n" + json.dumps(per_round[n - 1]) + "\n```"
            yield bridge._sse({"delta": f"Round {state['n']} summary.\n{block}"})
            yield bridge._sse("[DONE]")
        elif "final deep-research report" in message:
            yield bridge._sse({"delta": _REPORT_BODY})
            yield bridge._sse("[DONE]")
        else:  # pragma: no cover - guard against a prompt template change
            raise AssertionError(f"unexpected prompt: {message[:80]!r}")

    return fake


@pytest.mark.anyio
async def test_run_two_rounds_accumulates_and_swaps_in_gap_prompt(monkeypatch):
    prompts: list[str] = []
    monkeypatch.setattr(bridge, "stream_turn",
                        _rounds_fake(prompts, [FINDINGS_R1, FINDINGS_R2]))
    job = research.Job(id="multi1", query="python news",
                       settings={"max_rounds": 2})

    await research._run(job)
    assert job.status == "done"

    # (3) total round count: exactly two round turns + one report turn ran.
    round_prompts = [p for p in prompts if "deep-research job" in p]
    report_prompts = [p for p in prompts if "final deep-research report" in p]
    assert len(round_prompts) == 2 and len(report_prompts) == 1
    assert "round 1 of" in round_prompts[0] and "round 2 of" in round_prompts[1]
    assert job.progress["round"] == 2

    # (2) the gap-filling extra is swapped in for round 2 ONLY.
    gap_marker = "You already researched this in earlier rounds"
    assert gap_marker not in round_prompts[0]
    assert gap_marker in round_prompts[1]

    # (1) findings/sources accumulate across rounds. NOTE: accumulation is the
    # cumulative-output contract (each round re-emits ALL findings so far and
    # the engine keeps the LAST extraction — `extract_findings(text) or
    # job.findings` only falls back on a parse miss), so round 2's cumulative
    # block carries both entries and nothing from round 1 is lost.
    assert job.findings == FINDINGS_R2
    assert [s["url"] for s in job.sources] == [
        "https://alpha.example", "https://beta.example"]

    # Cross-round notes accumulation: the report prompt inlines BOTH rounds'
    # stripped summaries (notes.append per round), not just the last one.
    assert "Round 1 summary." in report_prompts[0]
    assert "Round 2 summary." in report_prompts[0]

    persisted = research._load_record("multi1")
    assert persisted["rounds"] == 2


@pytest.mark.anyio
async def test_run_clamps_requested_rounds_to_max(monkeypatch):
    # max_rounds is user-reachable via the /start payload — a huge ask must be
    # clamped to MAX_ROUNDS, never run verbatim.
    prompts: list[str] = []
    monkeypatch.setattr(bridge, "stream_turn", _rounds_fake(prompts, [FINDINGS]))
    job = research.Job(id="clamp1", query="python news",
                       settings={"max_rounds": 99})

    await research._run(job)

    assert job.status == "done"
    assert len([p for p in prompts
                if "deep-research job" in p]) == research.MAX_ROUNDS
    assert research._load_record("clamp1")["rounds"] == research.MAX_ROUNDS


# --- _maybe_compare: trigger/skip conditions --------------------------------

@pytest.mark.anyio
async def test_maybe_compare_triggers_for_comparison_query(monkeypatch):
    job = research.Job(id="cmp1", query="Python vs Rust for web backends",
                       settings={}, result="a finished report")
    seen = {}

    async def fake_turn(prompt, session_key, model_ref, on_event=None, expect=None):
        seen["session_key"] = session_key
        seen["prompt_has_query"] = "Python vs Rust" in prompt
        return ('```json\n{"title": "Python vs Rust", "columns": ["Python", "Rust"],'
                ' "rows": [{"label": "speed", "cells": ["slower", "faster"]}]}\n```')

    monkeypatch.setattr(research, "_turn", fake_turn)
    await research._maybe_compare(job, "sess1", None)

    assert seen["session_key"] == "sess1-compare"
    assert seen["prompt_has_query"] is True
    assert job.comparison["columns"] == ["Python", "Rust"]
    assert job.comparison["rows"][0]["label"] == "speed"


@pytest.mark.anyio
async def test_maybe_compare_skips_non_comparison_query(monkeypatch):
    job = research.Job(id="cmp2", query="tell me about pandas",
                       settings={}, result="a finished report")
    called = False

    async def fake_turn(*a, **kw):
        nonlocal called
        called = True
        return "null"

    monkeypatch.setattr(research, "_turn", fake_turn)
    await research._maybe_compare(job, "sess1", None)

    assert called is False
    assert job.comparison is None


@pytest.mark.anyio
async def test_maybe_compare_skips_when_no_result_yet(monkeypatch):
    job = research.Job(id="cmp3", query="Python vs Rust", settings={}, result=None)
    called = False

    async def fake_turn(*a, **kw):
        nonlocal called
        called = True

    monkeypatch.setattr(research, "_turn", fake_turn)
    await research._maybe_compare(job, "sess1", None)

    assert called is False   # comparison gate requires a finished report first


@pytest.mark.anyio
async def test_maybe_compare_swallows_failure_and_leaves_comparison_none(monkeypatch):
    job = research.Job(id="cmp4", query="Python vs Rust", settings={},
                       result="a finished report", comparison=None)

    async def boom(*a, **kw):
        raise RuntimeError("writer turn timed out")

    monkeypatch.setattr(research, "_turn", boom)
    await research._maybe_compare(job, "sess1", None)  # must not raise

    assert job.comparison is None


# --- Routes: start / status / stream / active -------------------------------

@pytest.mark.anyio
async def test_start_route_returns_session_id_and_job_starts_running(monkeypatch):
    monkeypatch.setattr(bridge, "stream_turn", _make_fake_stream_turn())
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/research/start", json={"query": "python news"})
        assert r.status_code == 200
        rid = r.json()["session_id"]
        assert rid in research._JOBS
        job = research._JOBS[rid]
        # Relies on deterministic asyncio scheduling: nothing has awaited the
        # job task yet, so the canned run can't have reached _finish — an edit
        # that awaits/yields more before this assert may flip it to "done".
        assert job.status == "running"   # not yet awaited — still in flight
        await job.task                    # let the canned run finish for cleanup

        r_bad = await c.post("/api/research/start", json={"query": "   "})
        assert r_bad.status_code == 400
    assert job.status == "done"


@pytest.mark.anyio
async def test_status_route_reflects_lifecycle_and_unknown_id_404(monkeypatch):
    monkeypatch.setattr(bridge, "stream_turn", _make_fake_stream_turn())
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/research/start", json={"query": "python news"})
        rid = r.json()["session_id"]

        running = await c.get(f"/api/research/status/{rid}")
        # Same deterministic-scheduling reliance as the start-route test: the
        # job task hasn't been awaited yet, so it can't have finished here.
        assert running.json()["status"] == "running"

        await research._JOBS[rid].task
        done = await c.get(f"/api/research/status/{rid}")
        assert done.json()["status"] == "done"
        assert done.json()["progress"]["final"] is True

        missing = await c.get("/api/research/status/does-not-exist")
        assert missing.status_code == 404


@pytest.mark.anyio
async def test_status_route_falls_back_to_persisted_record():
    # "finished in an earlier process life": no in-memory Job, only a vault record.
    job = research.Job(id="past1", query="old query", settings={}, status="done",
                       result="# Report\n\nDone.",
                       sources=[{"title": "A", "url": "https://a.example"}])
    research._save_record(job, rounds=1)

    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.get("/api/research/status/past1")
    assert r.status_code == 200
    assert r.json() == {"status": "done", "progress": {}}


@pytest.mark.anyio
async def test_stream_route_snapshot_for_finished_and_unknown_job(monkeypatch):
    monkeypatch.setattr(bridge, "stream_turn", _make_fake_stream_turn())
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/research/start", json={"query": "python news"})
        rid = r.json()["session_id"]
        await research._JOBS[rid].task   # deterministic: run to completion first

        finished = await c.get(f"/api/research/stream/{rid}")
        frames = _sse_frames(finished.text)
        assert frames[-1]["final"] is True and frames[-1]["status"] == "done"

        unknown = await c.get("/api/research/stream/does-not-exist")
        assert _sse_frames(unknown.text) == [{"status": "not_found"}]


@pytest.mark.anyio
async def test_stream_route_live_events_for_running_job(monkeypatch):
    # Gate the fake bridge so the job cannot finish until we release it —
    # guarantees the run is still "running" (not a race) while we're
    # subscribed, and that a searching/reading phase is observable.
    #
    # NOTE: consumed via the route handler's own generator (research.stream()
    # called directly), NOT through AsyncClient/ASGITransport — ASGITransport
    # drives a StreamingResponse to full completion before handing back any
    # bytes, so pumping an in-flight (still-running) SSE generator through it
    # deadlocks. This mirrors the documented limitation in test_resume_route.py
    # ("an infinite SSE that a request client can't cleanly bound") and the
    # same direct-call technique test_chat_resume_detached.py and
    # test_jobs.py::test_jobs_stream_first_frame_is_snapshot use for the same
    # reason. /start is still driven through the real ASGI app + routing.
    release = asyncio.Event()
    monkeypatch.setattr(bridge, "stream_turn", _make_fake_stream_turn(gate=release))

    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/research/start", json={"query": "python news"})
        rid = r.json()["session_id"]
    job = research._JOBS[rid]

    resp = await research.stream(rid)
    gen = resp.body_iterator
    events = []
    try:
        while True:
            frame = await gen.__anext__()
            ev = json.loads(frame[len("data: "):].strip())
            events.append(ev)
            if ev.get("phase") in ("searching", "reading") and not release.is_set():
                release.set()   # let the gated round turn complete
            if ev.get("final"):
                break
    finally:
        await gen.aclose()

    await job.task   # engine already finished; this just avoids a dangling task

    assert any(e.get("phase") in ("searching", "reading") for e in events)
    assert events[-1]["final"] is True and events[-1]["status"] == "done"


@pytest.mark.anyio
async def test_active_route_lists_running_job_and_excludes_finished_ones(monkeypatch):
    release = asyncio.Event()
    monkeypatch.setattr(bridge, "stream_turn", _make_fake_stream_turn(gate=release))

    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://t") as c:
        r = await c.post("/api/research/start", json={"query": "python news"})
        rid = r.json()["session_id"]

        active = (await c.get("/api/research/active")).json()["active"]
        assert [a for a in active if a["session_id"] == rid][0]["query"] == "python news"

        release.set()
        await research._JOBS[rid].task

        active_after = (await c.get("/api/research/active")).json()["active"]
        assert rid not in [a["session_id"] for a in active_after]
