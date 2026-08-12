"""task_ingest mirrors tmp/jobs/*.json and share/tasks/*/progress.json into
the registry: create, progress-merge, stall derivation, vanish → interrupted
(running) / remove (terminal). Uses real files in tmp fixtures — the same
atomic-JSON contract bin/job writes."""
import json
import time

import pytest

from backend import task_ingest, task_registry


@pytest.fixture(autouse=True)
def _fresh(tmp_path, monkeypatch):
    task_registry.reset_for_tests()
    jobs_dir = tmp_path / "jobs"
    tasks_dir = tmp_path / "share" / "tasks"
    jobs_dir.mkdir(parents=True)
    tasks_dir.mkdir(parents=True)
    monkeypatch.setattr(task_ingest, "_jobs_dir", lambda: jobs_dir)
    monkeypatch.setattr(task_ingest, "_taskfiles_dir", lambda: tasks_dir)
    yield
    task_registry.reset_for_tests()


def _write_job(tmp, jid, **fields):
    rec = {"id": jid, "label": jid, "status": "running",
           "_updatedEpoch": time.time(), **fields}
    (task_ingest._jobs_dir() / f"{jid}.json").write_text(json.dumps(rec))
    return rec


def test_job_file_becomes_registry_record(tmp_path):
    _write_job(tmp_path, "render566", pct=42.5, detail="frame 230/540")
    task_ingest.scan_once()
    rec = task_registry.get("job:render566")
    assert rec["kind"] == "job" and rec["pct"] == 42.5
    assert rec["extra"]["native"]["id"] == "render566"


def test_stalled_running_job(tmp_path):
    _write_job(tmp_path, "quiet", _updatedEpoch=time.time() - 120)
    task_ingest.scan_once()
    assert task_registry.get("job:quiet")["state"] == "stalled"


def test_vanished_running_job_is_interrupted(tmp_path):
    _write_job(tmp_path, "gone")
    task_ingest.scan_once()
    (task_ingest._jobs_dir() / "gone.json").unlink()
    task_ingest.scan_once()
    assert task_registry.get("job:gone")["state"] == "interrupted"


def test_vanished_terminal_job_is_removed(tmp_path):
    _write_job(tmp_path, "finished", status="done")
    task_ingest.scan_once()
    (task_ingest._jobs_dir() / "finished.json").unlink()
    task_ingest.scan_once()
    assert task_registry.get("job:finished") is None


def test_interrupted_record_lingers_after_vanish(tmp_path):
    _write_job(tmp_path, "vanish")
    task_ingest.scan_once()
    (task_ingest._jobs_dir() / "vanish.json").unlink()
    task_ingest.scan_once()          # marks interrupted
    task_ingest.scan_once()          # must NOT remove it
    rec = task_registry.get("job:vanish")
    assert rec is not None and rec["state"] == "interrupted"


def test_taskfile_progress_with_session_key(tmp_path):
    d = task_ingest._taskfiles_dir() / "t1"
    d.mkdir()
    payload = {"id": "t1", "label": "publish site", "status": "running",
               "pct": 80, "sessionKey": "agent:main:web-6b3ccecab880",
               "kind": "publish"}
    (d / "progress.json").write_text(json.dumps(payload))
    task_ingest.scan_once()
    rec = task_registry.get("taskfile:t1")
    assert rec["session_key"] == "agent:main:web-6b3ccecab880"
    assert rec["extra"]["native"]["kind"] == "publish"


def test_malformed_file_is_skipped(tmp_path):
    (task_ingest._jobs_dir() / "bad.json").write_text("{not json")
    task_ingest.scan_once()          # must not raise
    assert task_registry.list_tasks() == []


def test_unchanged_scan_emits_nothing(tmp_path):
    import asyncio

    async def main():
        _write_job(tmp_path, "steady", pct=10)
        task_ingest.scan_once()
        q = task_registry.subscribe()
        try:
            task_ingest.scan_once()          # nothing changed on disk
            assert q.qsize() == 0
        finally:
            task_registry.unsubscribe(q)
    asyncio.run(main())


def test_changed_content_still_emits(tmp_path):
    import asyncio

    async def main():
        _write_job(tmp_path, "moving", pct=10)
        task_ingest.scan_once()
        q = task_registry.subscribe()
        try:
            _write_job(tmp_path, "moving", pct=20)
            task_ingest.scan_once()
            assert q.qsize() >= 1
        finally:
            task_registry.unsubscribe(q)
    asyncio.run(main())


def test_stale_terminal_file_never_ingested(tmp_path):
    import time as _t
    _write_job(tmp_path, "ancient", status="done",
               _updatedEpoch=_t.time() - task_registry.RETAIN_TERMINAL_S - 10)
    task_ingest.scan_once()
    assert task_registry.get("job:ancient") is None


def test_stale_running_taskfile_ignored(tmp_path):
    import json as _json
    import os
    d = task_ingest._taskfiles_dir() / "ghost"
    d.mkdir()
    pj = d / "progress.json"
    pj.write_text(_json.dumps({"id": "ghost", "label": "ghost", "status": "running"}))
    old = time.time() - task_ingest.RUNNING_MAX_AGE_S - 60
    os.utime(pj, (old, old))
    task_ingest.scan_once()
    assert task_registry.get("taskfile:ghost") is None


from backend.task_ingest import _state_for, normalize_terminal


def test_completed_is_a_terminal_synonym_for_done():
    assert normalize_terminal("completed") == "done"
    assert normalize_terminal("Complete") == "done"
    assert normalize_terminal("success") == "done"
    assert normalize_terminal("ok") == "done"
    assert normalize_terminal("finished") == "done"


def test_error_words_map_to_failed():
    assert normalize_terminal("error") == "failed"
    assert normalize_terminal("fail") == "failed"
    assert normalize_terminal("failed") == "failed"


def test_unknown_and_running_are_not_terminal():
    assert normalize_terminal("running") is None
    assert normalize_terminal("wibble") is None
    assert normalize_terminal("") is None
    assert normalize_terminal(None) is None


def test_completed_record_renders_done_not_running():
    # The originating bug: a shipped episode showed as a stuck running job.
    native = {"id": "bwg-ship-571", "status": "completed", "pct": 100}
    assert _state_for(native, updated_epoch=1000.0, now=1000.0) == "done"


def test_unknown_status_stalls_when_quiet_instead_of_running_forever():
    # Previously any unrecognised word fell through to "running" and, because
    # the stall check was gated on status == "running", never escalated.
    native = {"id": "x", "status": "wibble"}
    assert _state_for(native, updated_epoch=1000.0, now=1000.0) == "running"
    assert _state_for(native, updated_epoch=1000.0, now=1000.0 + 31) == "stalled"
