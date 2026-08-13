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


def test_native_pid_reaches_the_registry_extra(tmp_path, monkeypatch):
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    task_ingest._upsert_native(
        "taskfile:x",
        {"id": "x", "status": "running", "pid": 4242, "label": "render"},
        updated_epoch=1000.0, now=1000.0, session_key=None)
    rec = task_registry.get("taskfile:x")
    assert rec["extra"]["pid"] == 4242


def test_missing_pid_is_absent_not_zero(tmp_path, monkeypatch):
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    task_ingest._upsert_native(
        "taskfile:y", {"id": "y", "status": "running"},
        updated_epoch=1000.0, now=1000.0, session_key=None)
    assert "pid" not in (task_registry.get("taskfile:y")["extra"] or {})


# --- Round-1 review fix (Critical-2): sticky-but-reversible death ---------
#
# The liveness sweeper (task_liveness) confirms a pid gone and marks the
# record `interrupted`. Without a guard, the very next 0.5s scan_once() pass
# would re-read the SAME lingering file — still saying "running" because its
# writer never got the chance to update it — and resurrect the row, undoing
# the sweeper's honest verdict. `_upsert_native` is now sticky against
# STALE evidence (a file that predates the verdict) but must still honor
# GENUINELY NEW evidence (a file written after the verdict) — the sweeper's
# job is to contradict a lying file, not to permanently silence a real one.


def test_interrupted_record_with_stale_file_stays_interrupted(tmp_path):
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    rec = task_registry.upsert(
        "taskfile:z", kind="job", source="taskfile", label="z",
        state="interrupted", detail="lost track of this process; outcome unknown")
    verdict_ms = rec["updated"]
    # The lingering file's own timestamp PREDATES the death verdict — same
    # stale content the sweeper already contradicted.
    stale_epoch = (verdict_ms / 1000.0) - 5
    task_ingest._upsert_native(
        "taskfile:z", {"id": "z", "status": "running", "label": "z"},
        updated_epoch=stale_epoch, now=stale_epoch + 1, session_key=None)
    assert task_registry.get("taskfile:z")["state"] == "interrupted"


def test_interrupted_record_with_fresh_file_resurrects_to_running(tmp_path):
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    rec = task_registry.upsert(
        "taskfile:z2", kind="job", source="taskfile", label="z2",
        state="interrupted", detail="lost track of this process; outcome unknown")
    verdict_ms = rec["updated"]
    # The file was written AFTER the verdict — genuine new evidence, and
    # honesty runs in both directions: this must be allowed to resurrect
    # the row, not just to kill it.
    fresh_epoch = (verdict_ms / 1000.0) + 5
    task_ingest._upsert_native(
        "taskfile:z2", {"id": "z2", "status": "running", "label": "z2"},
        updated_epoch=fresh_epoch, now=fresh_epoch + 1, session_key=None)
    assert task_registry.get("taskfile:z2")["state"] == "running"


# --- Round-2 review fix (Important): a terminal file must always outrank --
# --- a confirmed-death verdict, even a stale one --------------------------
#
# The sticky-death guard above (Critical-2) suppressed ANY lingering file
# that predated the verdict, regardless of what the file now says. Concrete
# failure: a job writes its terminal status and exits — normal shutdown IS
# "write terminal file, then exit" — and the sweeper's own death check can
# land microseconds later with an mtime that's technically "before" the
# verdict. Without this exemption the row reports "lost track of this
# process; outcome unknown" for RETAIN_TERMINAL_S and then is pruned — a
# real `done` job's outcome never shown to the user, exactly the kind of lie
# this whole module exists to prevent. A terminal file is the producer's
# final word and must always be allowed through.


def test_interrupted_record_with_terminal_file_becomes_done_even_if_stale(tmp_path):
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    rec = task_registry.upsert(
        "taskfile:z5", kind="job", source="taskfile", label="z5",
        state="interrupted", detail="lost track of this process; outcome unknown")
    verdict_ms = rec["updated"]
    # mtime PREDATES the verdict — the same "stale" shape as the C2 test —
    # but the status is a terminal synonym ("completed", not literally
    # "done"), exercising Task 1's normalize_terminal in the same breath.
    stale_epoch = (verdict_ms / 1000.0) - 5
    task_ingest._upsert_native(
        "taskfile:z5", {"id": "z5", "status": "completed", "label": "z5"},
        updated_epoch=stale_epoch, now=stale_epoch + 1, session_key=None)
    assert task_registry.get("taskfile:z5")["state"] == "done"


def test_interrupted_record_with_stale_running_file_still_stays_interrupted(tmp_path):
    # The C2 regression test, re-asserted: the terminal exemption must not
    # weaken the original guard for a file that's still claiming "running".
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    rec = task_registry.upsert(
        "taskfile:z6", kind="job", source="taskfile", label="z6",
        state="interrupted", detail="lost track of this process; outcome unknown")
    verdict_ms = rec["updated"]
    stale_epoch = (verdict_ms / 1000.0) - 5
    task_ingest._upsert_native(
        "taskfile:z6", {"id": "z6", "status": "running", "label": "z6"},
        updated_epoch=stale_epoch, now=stale_epoch + 1, session_key=None)
    assert task_registry.get("taskfile:z6")["state"] == "interrupted"


def test_interrupted_record_with_zero_epoch_file_stays_interrupted(tmp_path):
    # Round-2 review fix: a file with no `_updatedEpoch` at all
    # (updated_epoch == 0) was exempted from the sticky-death guard on the
    # theory that "unknown age" shouldn't count as "predates the verdict".
    # That reasoning was itself a bug (round-3 finding): bypassing the guard
    # doesn't land on a neutral "unknown" outcome here — `_state_for` ALSO
    # short-circuits on a falsy updated_epoch straight to "running", so
    # letting it through made the row assert the process is ALIVE with zero
    # confirmation, directly contradicting a death already confirmed by
    # pid. Everywhere else in this module and in task_liveness, "unknown"
    # resolves to the CONSERVATIVE outcome (never claim death without
    # confirmation); the same direction applies here too (never let an
    # undateable file overturn a death already confirmed). An undateable
    # file is not NEW evidence, so the row must stay `interrupted`.
    from backend import task_ingest, task_registry
    task_registry.reset_for_tests()
    rec = task_registry.upsert(
        "taskfile:z7", kind="job", source="taskfile", label="z7",
        state="interrupted", detail="lost track of this process; outcome unknown")
    task_ingest._upsert_native(
        "taskfile:z7", {"id": "z7", "status": "running", "label": "z7"},
        updated_epoch=0.0, now=rec["updated"] / 1000.0 + 10, session_key=None)
    assert task_registry.get("taskfile:z7")["state"] == "interrupted"


def test_an_attached_taskfile_writes_into_the_observed_row(tmp_path, monkeypatch):
    from backend import task_merge
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    task_registry.upsert("observed:200:20", kind="observed", source="observed",
                         label="bin/task run", session_key="chat-1",
                         state="running",
                         extra={"pid": 200, "subtree": [200, 300], "observed": True})
    tasks = tmp_path / "share" / "tasks" / "render"
    tasks.mkdir(parents=True)
    (tasks / "progress.json").write_text(json.dumps(
        {"id": "render", "label": "render", "status": "running", "pct": 42.0,
         "pid": 300, "sessionKey": "chat-1", "detail": "encoding"}))
    monkeypatch.setattr(task_ingest, "_taskfiles_dir", lambda: tmp_path / "share" / "tasks")
    monkeypatch.setattr(task_ingest, "_jobs_dir", lambda: tmp_path / "nojobs")
    task_ingest.scan_once()
    rows = task_registry.list_tasks()
    # One row, not two: the producer's detail on the observer's row.
    assert [r["id"] for r in rows] == ["observed:200:20"]
    assert rows[0]["pct"] == 42.0
    assert rows[0]["detail"] == "encoding"
    assert rows[0]["state"] == "running"
    # Pin the partial-extra contract: `_upsert_attached` passes only
    # native/updated_epoch/producer_ms, so task_registry.upsert's dict.update
    # merge must leave the observer's own pid/subtree/observed keys intact.
    # A regression to a full-extra write would silently wipe these and no
    # other assertion here would catch it.
    assert rows[0]["extra"]["subtree"] == [200, 300]
    assert rows[0]["extra"]["observed"] is True


def test_a_session_attached_taskfile_does_not_overwrite_the_observed_rows_label(
        tmp_path, monkeypatch):
    # bin/task start writes no pid at all, so this can only attach by
    # sessionKey — soft evidence (the only live observed row in this chat,
    # not proof this producer IS that job). It may contribute pct/detail but
    # must never relabel the row.
    from backend import task_merge
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    task_registry.upsert("observed:200:20", kind="observed", source="observed",
                         label="bin/task run", session_key="chat-1",
                         state="running",
                         extra={"pid": 200, "subtree": [200, 300], "observed": True})
    tasks = tmp_path / "share" / "tasks" / "render"
    tasks.mkdir(parents=True)
    (tasks / "progress.json").write_text(json.dumps(
        {"id": "render", "label": "a completely different label", "status": "running",
         "pct": 10.0, "sessionKey": "chat-1", "detail": "uploading"}))
    monkeypatch.setattr(task_ingest, "_taskfiles_dir", lambda: tmp_path / "share" / "tasks")
    monkeypatch.setattr(task_ingest, "_jobs_dir", lambda: tmp_path / "nojobs")
    task_ingest.scan_once()
    rows = task_registry.list_tasks()
    assert [r["id"] for r in rows] == ["observed:200:20"]
    assert rows[0]["label"] == "bin/task run"
    assert rows[0]["pct"] == 10.0
    assert rows[0]["detail"] == "uploading"


def test_a_session_attached_taskfiles_completed_does_not_close_the_observed_row(
        tmp_path, monkeypatch):
    # The other half of the soft-attach fix: even the producer's own terminal
    # word must not close a row it only reached by sessionKey guesswork — the
    # observed process could still be running.
    from backend import task_merge
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    task_registry.upsert("observed:200:20", kind="observed", source="observed",
                         label="bin/task run", session_key="chat-1",
                         state="running",
                         extra={"pid": 200, "subtree": [200, 300], "observed": True})
    tasks = tmp_path / "share" / "tasks" / "render"
    tasks.mkdir(parents=True)
    (tasks / "progress.json").write_text(json.dumps(
        {"id": "render", "label": "render", "status": "completed", "pct": 100.0,
         "sessionKey": "chat-1", "detail": "done"}))
    monkeypatch.setattr(task_ingest, "_taskfiles_dir", lambda: tmp_path / "share" / "tasks")
    monkeypatch.setattr(task_ingest, "_jobs_dir", lambda: tmp_path / "nojobs")
    task_ingest.scan_once()
    rec = task_registry.get("observed:200:20")
    assert rec["state"] == "running"


def test_upsert_attached_skips_a_non_terminal_write_onto_an_interrupted_row():
    # Same stale-evidence rule _upsert_native enforces: once the observer has
    # confirmed the row dead (`interrupted`), a producer file that keeps
    # advancing must not resurrect its pct/detail — "interrupted, 87%,
    # encoding" reads as alive. Calls _upsert_attached directly (the same
    # pattern the sticky-death guard tests above use for _upsert_native) so
    # the guard is pinned regardless of how target_for's own sticky-drop
    # logic happens to route on any given scan.
    task_registry.reset_for_tests()
    task_registry.upsert("observed:200:20", kind="observed", source="observed",
                         label="bin/task run", session_key="chat-1",
                         state="interrupted",
                         detail="lost track of this process; outcome unknown",
                         extra={"pid": 200, "subtree": [200, 300], "observed": True})
    task_ingest._upsert_attached(
        "observed:200:20",
        {"id": "render", "status": "running", "pct": 87.0, "detail": "encoding"},
        updated_epoch=1000.0, session_key="chat-1")
    rec = task_registry.get("observed:200:20")
    assert rec["state"] == "interrupted"
    assert rec["pct"] is None
    assert rec["detail"] == "lost track of this process; outcome unknown"


def test_a_session_attached_producers_error_does_not_reach_the_observed_row():
    # Round-2 review: `error` slipped through the label/state gate — a
    # session attach is soft evidence and must not put an error claim onto a
    # row it never proved it owns, same as it must not relabel it. Only a
    # pid-proven attach may write `error`.
    from backend import task_merge
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    row_pid = task_registry.upsert(
        "observed:200:20", kind="observed", source="observed",
        label="bin/task run", session_key="chat-1", state="running",
        extra={"pid": 200, "subtree": [200, 300], "observed": True})["id"]
    row_session = task_registry.upsert(
        "observed:600:60", kind="observed", source="observed",
        label="bin/task run", session_key="chat-2", state="running",
        extra={"pid": 600, "subtree": [600], "observed": True})["id"]
    assert task_merge.target_for({"id": "p", "pid": 300}, "chat-1") == row_pid
    assert task_merge.target_for({"id": "s"}, "chat-2") == row_session
    task_ingest._upsert_attached(
        row_pid, {"id": "p", "pid": 300, "status": "error", "error": "boom"},
        updated_epoch=1000.0, session_key="chat-1")
    task_ingest._upsert_attached(
        row_session, {"id": "s", "status": "error", "error": "boom"},
        updated_epoch=1000.0, session_key="chat-2")
    assert task_registry.get(row_pid)["error"] == "boom"
    assert task_registry.get(row_session)["error"] == ""
