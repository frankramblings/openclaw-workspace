"""Behavioral tests for the Live Jobs API (jobs.py): `_read_all` now reads
job:* records out of task_registry (populated by task_ingest's directory
scan) instead of globbing tmp/jobs/*.json itself. "stalled" derivation lives
in task_ingest; `_read_all` still re-applies its own tighter RETAIN_SECS
terminal window on top of the registry's longer RETAIN_TERMINAL_S. These
tests seed real files and run `task_ingest.scan_once()` (same fixture
pattern as test_task_ingest.py) to populate the registry, then pin
`_read_all`'s output contract and the two routes that expose it
(`/api/jobs`, `/api/jobs/stream`) and the per-job log tail route.
"""
import json
import time

import pytest
from fastapi.testclient import TestClient

from backend import jobs, task_ingest, task_registry


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def jobs_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(jobs, "JOBS_DIR", tmp_path)
    # jobs.py no longer globs the directory itself — task_ingest.scan_once()
    # does, and jobs._read_all reads what it upserted into the registry.
    monkeypatch.setattr(task_ingest, "_jobs_dir", lambda: tmp_path)
    task_registry.reset_for_tests()
    yield tmp_path
    task_registry.reset_for_tests()


def _write(d, jid, status="running", ago=0, **extra):
    rec = {"id": jid, "status": status, "_updatedEpoch": time.time() - ago,
          "startedAt": "2026-07-08T10:00:00"}
    rec.update(extra)
    (d / f"{jid}.json").write_text(json.dumps(rec))
    return rec


# --- _read_all: store round-trip + fail-soft parsing ------------------------

def test_read_all_round_trips_and_strips_private_fields(jobs_dir):
    _write(jobs_dir, "j1", status="running", ago=1, pct=42, label="Render",
          _pctExplicit=True)
    task_ingest.scan_once()   # _read_all reads the registry now, not the directory

    [rec] = jobs._read_all()
    assert rec["id"] == "j1" and rec["status"] == "running" and rec["pct"] == 42
    assert "_updatedEpoch" not in rec and "_pctExplicit" not in rec


def test_read_all_skips_malformed_and_idless_files(jobs_dir):
    (jobs_dir / "garbage.json").write_text("{not valid json")
    (jobs_dir / "noid.json").write_text(json.dumps({"status": "running"}))
    (jobs_dir / "notdict.json").write_text(json.dumps(["a", "list"]))
    _write(jobs_dir, "ok1", status="running", ago=1)
    task_ingest.scan_once()   # scan_once itself is the fail-soft file parser now

    recs = jobs._read_all()
    assert [r["id"] for r in recs] == ["ok1"]   # malformed/id-less entries never crash the read


# --- state transitions: stall derivation + terminal eviction ----------------

def test_read_all_marks_stalled_running_job_only_when_quiet_too_long(jobs_dir):
    _write(jobs_dir, "fresh", status="running", ago=2)
    # "stalled" is now derived by task_ingest (its own STALL_S), not jobs.py
    _write(jobs_dir, "quiet", status="running", ago=task_ingest.STALL_S + 5)
    task_ingest.scan_once()

    by_id = {r["id"]: r for r in jobs._read_all()}
    assert "stalled" not in by_id["fresh"]
    assert by_id["quiet"]["stalled"] >= task_ingest.STALL_S


def test_read_all_evicts_expired_terminal_jobs_but_keeps_recent_ones(jobs_dir):
    _write(jobs_dir, "old_done", status="done", ago=jobs.RETAIN_SECS + 10)
    _write(jobs_dir, "recent_done", status="done", ago=5)
    _write(jobs_dir, "recent_failed", status="failed", ago=5)
    _write(jobs_dir, "running_forever", status="running", ago=jobs.RETAIN_SECS + 10)
    task_ingest.scan_once()
    # The registry's own `updated` tracks ingestion time, not the source
    # file's `_updatedEpoch` — a freshly-ingested "old" file is NOT old by
    # the registry's clock. Back-date it directly (same technique as
    # test_task_registry.py's prune test) to simulate a record that has
    # genuinely been sitting past RETAIN_SECS since it was last upserted.
    task_registry._TASKS["job:old_done"]["updated"] -= (jobs.RETAIN_SECS + 10) * 1000

    ids = {r["id"] for r in jobs._read_all()}
    # terminal + past the retain window -> swept; terminal + recent -> kept;
    # "running" is never subject to the retain window, no matter how stale.
    assert ids == {"recent_done", "recent_failed", "running_forever"}


def test_read_all_sorts_running_then_failed_then_done_by_recency(jobs_dir):
    _write(jobs_dir, "done1", status="done", ago=1, startedAt="2026-07-08T09:00:00")
    _write(jobs_dir, "failed1", status="failed", ago=1, startedAt="2026-07-08T09:30:00")
    _write(jobs_dir, "run_old", status="running", ago=1, startedAt="2026-07-08T08:00:00")
    _write(jobs_dir, "run_new", status="running", ago=1, startedAt="2026-07-08T11:00:00")
    task_ingest.scan_once()

    ids = [r["id"] for r in jobs._read_all()]
    assert ids == ["run_new", "run_old", "failed1", "done1"]


# --- Routes -------------------------------------------------------------------

def test_jobs_route_returns_current_snapshot(jobs_dir):
    _write(jobs_dir, "j1", status="running", ago=1, label="Render 566")
    task_ingest.scan_once()

    from backend.app import app
    client = TestClient(app)
    r = client.get("/api/jobs")
    assert r.status_code == 200
    body = r.json()
    assert body["jobs"][0]["id"] == "j1" and body["jobs"][0]["label"] == "Render 566"


@pytest.mark.anyio
async def test_jobs_stream_first_frame_is_snapshot(jobs_dir):
    _write(jobs_dir, "j1", status="running", ago=1, pct=40)
    task_ingest.scan_once()

    resp = await jobs.jobs_stream()
    gen = resp.body_iterator
    try:
        first = await gen.__anext__()
        assert first.startswith("data: ")
        frame = json.loads(first[len("data: "):].strip())
        assert frame["jobs"][0]["id"] == "j1" and frame["jobs"][0]["pct"] == 40
    finally:
        await gen.aclose()   # bounded: never touch the subscriber wait after frame 1


def test_job_log_route_tails_and_clamps_length(jobs_dir):
    lines = [f"line {i}" for i in range(2500)]
    (jobs_dir / "j1.log").write_text("\n".join(lines))

    from backend.app import app
    client = TestClient(app)
    r = client.get("/api/jobs/j1/log?tail=999999")
    got = r.text.splitlines()
    assert len(got) == 2000                    # clamped to the 2000-line ceiling
    assert got[-1] == "line 2499" and got[0] == "line 500"

    r_default = client.get("/api/jobs/j1/log")
    assert len(r_default.text.splitlines()) == 300   # default tail


def test_job_log_route_rejects_invalid_id_without_touching_disk(jobs_dir):
    # _ID_RE (^[A-Za-z0-9_]+$) gates the id BEFORE it's used to build a
    # filesystem path — any of these single-path-segment ids must 404 without
    # ever reading JOBS_DIR, regardless of whether a same-named file exists.
    (jobs_dir / "a.b.log").write_text("should never be served")
    from backend.app import app
    client = TestClient(app)
    for bad in ("a.b", "a-b", "a$b"):
        r = client.get(f"/api/jobs/{bad}/log")
        assert r.status_code == 404, bad
