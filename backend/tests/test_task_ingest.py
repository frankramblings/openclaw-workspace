"""task_ingest mirrors tmp/jobs/*.json and share/tasks/*/progress.json into
the registry: create, progress-merge, stall derivation, vanish → interrupted
(running) / remove (terminal). Uses real files in tmp fixtures — the same
atomic-JSON contract bin/job writes."""
import asyncio
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


# --- Final review, Critical 1: the merge must RETRACT the row it drops ----
#
# `bin/task run` writes progress.json within a second of starting, so the
# 0.5s scan gives the producer its own row well before the observer surfaces
# the chain at 6s. When the merge then attaches, dropping that already-
# broadcast row silently left every connected client holding it forever,
# frozen at the pct it had at second 6, beside the observed row — the
# duplicate row this wave exists to remove.


def test_a_merge_attach_retracts_the_producers_own_row_on_the_stream(tmp_path):
    import asyncio

    from backend import task_merge

    async def main():
        task_merge.reset_for_tests()
        d = task_ingest._taskfiles_dir() / "render"
        d.mkdir(parents=True)
        (d / "progress.json").write_text(json.dumps(
            {"id": "render", "label": "render", "status": "running", "pct": 12.0,
             "pid": 300, "sessionKey": "chat-1", "detail": "starting"}))
        # Second ~1: no observed row exists yet, so the producer opens its own
        # and every connected client is told about it.
        task_ingest.scan_once()
        assert task_registry.get("taskfile:render") is not None
        # Second 6: the observer surfaces the chain the producer runs inside.
        task_registry.upsert("observed:200:20", kind="observed", source="observed",
                             label="bin/task run", session_key="chat-1",
                             state="running",
                             extra={"pid": 200, "subtree": [200, 300],
                                    "observed": True})
        q = task_registry.subscribe()
        try:
            task_ingest.scan_once()
            frames = [q.get_nowait() for _ in range(q.qsize())]
            assert task_registry.get("taskfile:render") is None
            assert {"type": task_registry.REMOVE_EVENT,
                    "id": "taskfile:render"} in frames
        finally:
            task_registry.unsubscribe(q)
    asyncio.run(main())


def test_a_vanished_terminal_rows_removal_stays_silent(tmp_path):
    # The wave-1 call site keeps its exact behavior: the row is already
    # terminal and the client prunes those on its own foreground timer, so
    # there is nothing to retract and no frame to spend.
    import asyncio

    async def main():
        _write_job(tmp_path, "finished", status="done")
        task_ingest.scan_once()
        (task_ingest._jobs_dir() / "finished.json").unlink()
        q = task_registry.subscribe()
        try:
            task_ingest.scan_once()
            assert task_registry.get("job:finished") is None
            assert q.qsize() == 0
        finally:
            task_registry.unsubscribe(q)
    asyncio.run(main())


def test_a_pidless_taskfile_keeps_its_own_row_beside_the_observed_one(
        tmp_path, monkeypatch):
    # Final review, Important 2: bin/task start writes no pid at all, and the
    # sessionKey fallback that used to attach it is gone — "the only live
    # observed row in this chat" is not evidence that THIS producer is that
    # job. Two rows (what main shows today) beats one row wearing another
    # command's label and percentage.
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
    rows = {r["id"]: r for r in task_registry.list_tasks()}
    assert set(rows) == {"observed:200:20", "taskfile:render"}
    # The observed row is untouched: no foreign label, no foreign percentage.
    assert rows["observed:200:20"]["label"] == "bin/task run"
    assert rows["observed:200:20"]["pct"] is None
    assert rows["observed:200:20"]["detail"] == ""
    # The producer still gets its own honest row.
    assert rows["taskfile:render"]["pct"] == 10.0
    assert rows["taskfile:render"]["label"] == "a completely different label"


def test_a_pidless_taskfiles_completed_does_not_close_the_observed_row(
        tmp_path, monkeypatch):
    # The other half: a pidless producer's own terminal word closes ITS row,
    # never the observed one it merely shares a chat with — that process may
    # well still be running.
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
    assert task_registry.get("observed:200:20")["state"] == "running"
    assert task_registry.get("taskfile:render")["state"] == "done"


def test_upsert_attached_skips_a_non_terminal_write_onto_an_interrupted_row():
    # Same stale-evidence rule _upsert_native enforces: once the observer has
    # confirmed the row dead (`interrupted`), a producer file that keeps
    # advancing must not resurrect its pct/detail — "interrupted, 87%,
    # encoding" reads as alive. Calls _upsert_attached directly (the same
    # pattern the sticky-death guard tests above use for _upsert_native) so
    # the guard is pinned regardless of how target_for's own sticky-drop
    # logic happens to route on any given scan.
    #
    # Final review, Minor: the task_merge._BOUND reset its neighbours all do
    # was missing here, so this producer ran with whatever binding an earlier
    # test happened to leave behind, and the assertions below would have kept
    # passing on the strength of an UNBOUND producer imposing nothing rather
    # than on the guard. Bind it for real — by pid, on a live row — and only
    # then let the observer's verdict land, so the skip is the guard's doing.
    from backend import task_merge
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    task_registry.upsert("observed:200:20", kind="observed", source="observed",
                         label="bin/task run", session_key="chat-1",
                         state="running",
                         extra={"pid": 200, "subtree": [200, 300], "observed": True})
    assert task_merge.target_for({"id": "render", "pid": 300},
                                 "chat-1") == "observed:200:20"
    task_registry.upsert("observed:200:20", kind="observed", source="observed",
                         state="interrupted",
                         detail="lost track of this process; outcome unknown")
    task_ingest._upsert_attached(
        "observed:200:20",
        {"id": "render", "pid": 300, "status": "running", "pct": 87.0,
         "detail": "encoding"},
        updated_epoch=1000.0, session_key="chat-1")
    rec = task_registry.get("observed:200:20")
    assert rec["state"] == "interrupted"
    assert rec["pct"] is None
    assert rec["detail"] == "lost track of this process; outcome unknown"


def test_only_a_bound_producers_error_reaches_the_observed_row():
    # After the sessionKey fallback was disabled, only pid-proven bindings
    # carry authority. This asserts that when a bound producer writes an error,
    # it lands on its own bound row but not on unrelated rows.
    from backend import task_merge
    task_registry.reset_for_tests()
    task_merge.reset_for_tests()
    row_pid = task_registry.upsert(
        "observed:200:20", kind="observed", source="observed",
        label="bin/task run", session_key="chat-1", state="running",
        extra={"pid": 200, "subtree": [200, 300], "observed": True})["id"]
    row_other = task_registry.upsert(
        "observed:600:60", kind="observed", source="observed",
        label="bin/task run", session_key="chat-2", state="running",
        extra={"pid": 600, "subtree": [600], "observed": True})["id"]
    assert task_merge.target_for({"id": "p", "pid": 300}, "chat-1") == row_pid
    assert task_merge.target_for({"id": "s"}, "chat-2") is None
    task_ingest._upsert_attached(
        row_pid, {"id": "p", "pid": 300, "status": "error", "error": "boom"},
        updated_epoch=1000.0, session_key="chat-1")
    assert task_registry.get(row_pid)["error"] == "boom"
    assert task_registry.get(row_pid)["state"] == "failed"
    assert task_registry.get(row_other)["error"] == ""


# --- Task 7: the observer runs inside the ingest loop ---------------------


@pytest.fixture()
def fresh_tick(monkeypatch):
    """tick() paces itself off module-level clocks. Without resetting them a
    test would inherit the previous test's `now` and silently skip the observe
    it is asserting on — passing for the wrong reason."""
    monkeypatch.setattr(task_ingest, "_last_observe", 0.0)
    monkeypatch.setattr(task_ingest, "_last_sweep", 0.0)


def test_the_ingest_loop_observes_before_it_scans(monkeypatch, fresh_tick):
    # Ordering is load-bearing: a chain surfaced by the observer must be in the
    # registry before the merge looks for an attach target in the same pass.
    from backend import observer
    calls = []
    monkeypatch.setattr(observer, "observe_once", lambda: calls.append("observe"))
    monkeypatch.setattr(task_ingest, "scan_once", lambda: calls.append("scan"))
    task_ingest.tick(now=1000.0)
    assert calls == ["observe", "scan"]


def test_the_observer_is_skipped_when_disabled(monkeypatch, fresh_tick):
    from backend import config, observer
    monkeypatch.setattr(config, "OBSERVER_ENABLED", False)
    calls = []
    monkeypatch.setattr(observer, "observe_once", lambda: calls.append("observe"))
    monkeypatch.setattr(task_ingest, "scan_once", lambda: calls.append("scan"))
    task_ingest.tick(now=1000.0)
    assert calls == ["scan"]


def test_a_failing_observer_never_stops_the_scan(monkeypatch, fresh_tick):
    from backend import observer
    calls = []

    def boom():
        calls.append("observe")
        raise RuntimeError("proc walk exploded")

    monkeypatch.setattr(observer, "observe_once", boom)
    monkeypatch.setattr(task_ingest, "scan_once", lambda: calls.append("scan"))
    task_ingest.tick(now=1000.0)
    assert calls == ["observe", "scan"]


# --- Task 2 review, Important 4: the unit follower forks systemctl, and ----
# --- must never do that on the event-loop thread ---------------------------
#
# tick() is synchronous and runs directly inside ingest_loop's coroutine turn
# — a blocking fork-and-wait there stalls the WHOLE server, not just this
# loop. The follower therefore does NOT live inside tick; it runs from
# ingest_loop via asyncio.to_thread, gated by its own module-level clock
# (_last_unit_poll), the same pattern _last_observe/_last_sweep use for
# tick's own gates.


@pytest.fixture()
def fresh_unit_poll(monkeypatch):
    """_maybe_follow_units paces itself off its own module-level clock,
    separate from tick's. Reset it for the same reason fresh_tick resets
    tick's clocks — otherwise a test inherits the previous test's `now` and
    silently skips the call it's asserting on."""
    monkeypatch.setattr(task_ingest, "_last_unit_poll", 0.0)


# --- Review round 2, finding 4 ---------------------------------------------
#
# Round 1's fix ran unit_follower.follow_once() via asyncio.to_thread — which
# made it upsert into task_registry off the event-loop thread, breaking a
# DOCUMENTED contract (task_registry.py: "Producers must call upsert from
# the event-loop thread"). The ruling was to honor that contract, not weaken
# it: split the follower into collect() (the blocking systemctl forks, no
# registry access — this is what runs via to_thread) and apply() (the pure
# state machine and every upsert — runs inline, back on the loop). These
# tests assert _maybe_follow_units calls them in that shape.


def test_the_unit_follower_collects_off_thread_then_applies_on_the_loop(
        monkeypatch, fresh_unit_poll):
    # Call order and argument passing alone do not pin the guarantee this
    # test is named for: wrapping BOTH collect() and apply() in one
    # asyncio.to_thread call — the exact regression that took two review
    # rounds to remove (task 2, round-1 finding new-D) — would still pass an
    # order/argument-only version of this test. Recording threading.get_ident()
    # inside each fake is what actually pins "off the event-loop thread, then
    # back on it".
    import threading

    from backend import unit_follower
    calls = []
    loop_thread_ident = threading.get_ident()

    def fake_collect():
        calls.append(("collect", threading.get_ident()))
        return "COLLECTED-SENTINEL"

    def fake_apply(collected, now):
        calls.append(("apply", collected, now, threading.get_ident()))

    monkeypatch.setattr(unit_follower, "collect", fake_collect)
    monkeypatch.setattr(unit_follower, "apply", fake_apply)
    asyncio.run(task_ingest._maybe_follow_units(1000.0))
    collect_kind, collect_ident = calls[0]
    assert collect_kind == "collect"
    apply_kind, collected, now, apply_ident = calls[1]
    assert apply_kind == "apply"
    # apply() receives EXACTLY what collect() returned, unmodified.
    assert collected == "COLLECTED-SENTINEL"
    assert isinstance(now, float)
    # The actual threading guarantee: collect() ran on a DIFFERENT thread
    # than the caller, and apply() ran back on the caller's (event-loop)
    # thread — not merely "some thread or other" for each.
    assert collect_ident != loop_thread_ident
    assert apply_ident == loop_thread_ident


def test_the_unit_follower_runs_on_its_own_cadence(monkeypatch, fresh_unit_poll):
    from backend import config, unit_follower
    calls = []
    monkeypatch.setattr(unit_follower, "collect", lambda: calls.append("pass"))
    monkeypatch.setattr(unit_follower, "apply", lambda collected, now: None)
    asyncio.run(task_ingest._maybe_follow_units(1000.0))
    assert calls == ["pass"]
    # Same pass again without advancing past UNIT_POLL_S: gated, no 2nd call.
    asyncio.run(task_ingest._maybe_follow_units(1000.0 + config.UNIT_POLL_S - 0.001))
    assert calls == ["pass"]
    # Advance past the cadence: fires again.
    asyncio.run(task_ingest._maybe_follow_units(1000.0 + config.UNIT_POLL_S + 1))
    assert calls == ["pass", "pass"]


def test_the_unit_follower_is_skipped_when_disabled(monkeypatch, fresh_unit_poll):
    from backend import config, unit_follower
    monkeypatch.setattr(config, "UNIT_FOLLOWER_ENABLED", False)
    calls = []
    monkeypatch.setattr(unit_follower, "collect", lambda: calls.append("collect"))
    monkeypatch.setattr(unit_follower, "apply", lambda collected, now: calls.append("apply"))
    asyncio.run(task_ingest._maybe_follow_units(1000.0))
    assert calls == []


def test_a_failing_collect_never_raises_out_of_the_gate(monkeypatch, fresh_unit_poll):
    from backend import unit_follower

    def boom():
        raise RuntimeError("systemctl exploded")

    monkeypatch.setattr(unit_follower, "collect", boom)
    asyncio.run(task_ingest._maybe_follow_units(1000.0))  # must not raise


def test_a_failing_apply_never_raises_out_of_the_gate(monkeypatch, fresh_unit_poll):
    from backend import unit_follower
    monkeypatch.setattr(unit_follower, "collect", lambda: None)

    def boom(collected, now):
        raise RuntimeError("state machine exploded")

    monkeypatch.setattr(unit_follower, "apply", boom)
    asyncio.run(task_ingest._maybe_follow_units(1000.0))  # must not raise


# --- Final whole-branch review, Important 1: a COMPOSITION defect ----------
#
# task_liveness.SWEEP_S and config.UNIT_POLL_S are both 5s and are stamped
# from the SAME `now` (ingest_loop's own clock), so they fire on identical
# iterations forever. A unit row's extra["pid"] is its ExecMainPID, already
# dead by the time systemd itself reports the unit has stopped — so if the
# liveness sweeper got a turn before the unit follower's own closing pass,
# it would confirm that pid dead and flip the row to `interrupted` ("outcome
# unknown"), queuing a false "lost track" push, before the follower ever
# wrote the honest `done`. Fixed by running _maybe_follow_units BEFORE
# tick() in ingest_loop. This test drives one iteration's worth of work in
# that fixed order and pins the CONSEQUENCE — the row never reads
# `interrupted` — rather than only the call order: a call-order test is
# exactly what let the threading regression (finding new-D, task 2 round 1)
# through earlier in this wave.


def test_a_units_close_is_not_preempted_by_the_liveness_sweeper(
        monkeypatch, fresh_tick, fresh_unit_poll):
    import subprocess

    from backend import config, proc_tree, task_liveness, unit_follower

    monkeypatch.setattr(config, "UNIT_FOLLOWER_ENABLED", True)
    monkeypatch.setattr(config, "OBSERVER_ENABLED", False)
    monkeypatch.setattr(config, "OBSERVE_THRESHOLD_S", 0)
    monkeypatch.setattr(proc_tree, "snapshot", lambda: {})
    unit_follower.reset_for_tests()

    # A pid that is genuinely, permanently dead — exactly what a unit's
    # ExecMainPID looks like by the time systemd itself reports the unit has
    # stopped (already reaped, not merely absent).
    dead = subprocess.Popen(["true"])
    dead.wait()

    job = {"Id": "podmigrate-readup.service", "Transient": "yes",
           "InvocationID": "abc123", "ActiveState": "active",
           "SubState": "running", "ExecMainPID": str(dead.pid),
           "ExecMainStatus": "0", "Result": "success",
           "Description": "[systemd-run] readup", "ActiveEnterTimestamp": ""}
    exited = {**job, "ActiveState": "inactive", "SubState": "dead",
             "ExecMainPID": "0"}

    try:
        # Surface the row. OBSERVE_THRESHOLD_S=0 means one pass is enough.
        monkeypatch.setattr(unit_follower, "_list_active", lambda: [job["Id"]])
        monkeypatch.setattr(unit_follower, "_show", lambda names: {job["Id"]: job})
        asyncio.run(task_ingest._maybe_follow_units(1000.0))
        row = task_registry.get("observed:unit:abc123")
        assert row is not None and row["state"] == "running"
        assert row["extra"]["pid"] == dead.pid

        # The unit has now exited cleanly and dropped off the active list.
        # Both cadence gates land on the SAME `now` here, on purpose,
        # reproducing exactly the composition the final review flagged.
        monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
        monkeypatch.setattr(
            unit_follower, "_show",
            lambda names: {job["Id"]: exited} if job["Id"] in names else {})
        now = 2000.0
        monkeypatch.setattr(task_ingest, "_last_unit_poll", now - config.UNIT_POLL_S)
        monkeypatch.setattr(task_ingest, "_last_sweep", now - task_liveness.SWEEP_S)

        # One loop iteration's worth of work, in the FIXED order (see
        # ingest_loop): the follower closes the row to `done` before the
        # sweeper ever gets a turn to look at its now-dead pid.
        asyncio.run(task_ingest._maybe_follow_units(now))
        assert task_registry.get("observed:unit:abc123")["state"] == "done"

        task_ingest.tick(now)
        # The sweeper ran on this same `now` (its gate is satisfied too) but
        # found nothing to do: the row already left task_liveness._LIVE, so
        # next_state declines it. It must never have read `interrupted` at
        # any point in this sequence.
        assert task_registry.get("observed:unit:abc123")["state"] == "done"
    finally:
        unit_follower.reset_for_tests()


# --- Closing the gap the review found in the test above ---------------------
#
# The test above calls `_maybe_follow_units(now)` and then `tick(now)`
# ITSELF, in the order IT chose — it restates the fix's ordering rather than
# reading it from `ingest_loop`. Reverting the two-line swap in `ingest_loop`
# (putting `tick(now)` back before `await _maybe_follow_units(now)`) leaves
# that test green, because nothing in it ever calls `ingest_loop`. This test
# drives one REAL iteration of `ingest_loop`'s own body — POLL_S patched
# small, the coroutine run as a task, cancelled once the row leaves `running`
# — and asserts the consequence: the row closes `done` with exactly one
# terminal push queued, titled the success one, never a "Lost track" ahead of
# a "Finished". Swap the two lines back and this fails (see the branch's test
# report for the revert-proof this claim was checked against, not assumed).


def test_ingest_loop_itself_runs_the_follower_before_the_sweep(
        monkeypatch, fresh_tick, fresh_unit_poll):
    import subprocess

    from backend import config, proc_tree, push, task_push, unit_follower

    monkeypatch.setattr(config, "UNIT_FOLLOWER_ENABLED", True)
    monkeypatch.setattr(config, "OBSERVER_ENABLED", False)
    monkeypatch.setattr(config, "OBSERVE_THRESHOLD_S", 0)
    monkeypatch.setattr(proc_tree, "snapshot", lambda: {})
    monkeypatch.setattr(task_ingest, "POLL_S", 0.01)
    unit_follower.reset_for_tests()

    # Push side effects, made deterministic and observable: bypass the
    # fast-success gate (orthogonal to what this test defends — see
    # test_task_push.py's own `slow`/MIN_SUCCESS_S convention), skip the real
    # subscriptions/unseen-followups files, and capture what actually gets
    # sent instead of reaching into _PENDING (ingest_loop's own drain() call
    # empties that list before this test ever gets a look at it).
    monkeypatch.setattr(task_push, "MIN_SUCCESS_S", 0.0)
    monkeypatch.setattr(push, "unseen_count", lambda: 0)
    sent = []

    async def fake_send(payload):
        sent.append(payload)
        return {"sent": 1, "pruned": 0}

    monkeypatch.setattr(push, "send", fake_send)
    task_push.reset_for_tests()

    # A pid that is genuinely, permanently dead — exactly what a unit's
    # ExecMainPID looks like by the time systemd itself reports the unit has
    # stopped — so the sweeper WOULD confirm it dead and close the row
    # `interrupted` if it got a turn before the follower's own closing pass.
    dead = subprocess.Popen(["true"])
    dead.wait()

    job = {"Id": "podmigrate-readup.service", "Transient": "yes",
           "InvocationID": "abc123", "ActiveState": "active",
           "SubState": "running", "ExecMainPID": str(dead.pid),
           "ExecMainStatus": "0", "Result": "success",
           "Description": "[systemd-run] readup", "ActiveEnterTimestamp": ""}
    exited = {**job, "ActiveState": "inactive", "SubState": "dead",
             "ExecMainPID": "0"}

    async def main():
        try:
            # Arrange: the row is already surfaced and running — setup, not
            # part of what this test asserts.
            monkeypatch.setattr(unit_follower, "_list_active", lambda: [job["Id"]])
            monkeypatch.setattr(unit_follower, "_show", lambda names: {job["Id"]: job})
            await task_ingest._maybe_follow_units(time.monotonic())
            row = task_registry.get("observed:unit:abc123")
            assert row is not None and row["state"] == "running"
            assert row["extra"]["pid"] == dead.pid

            # The unit has now exited cleanly and dropped off the active list.
            monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
            monkeypatch.setattr(
                unit_follower, "_show",
                lambda names: {job["Id"]: exited} if job["Id"] in names else {})

            # Re-zero both cadence gates so the loop's own FIRST spin — its
            # `now` comes from time.monotonic() read INSIDE ingest_loop, not
            # supplied by this test — clears both, reproducing the exact
            # composition the final review flagged: task_liveness.SWEEP_S ==
            # config.UNIT_POLL_S == 5s, stamped from the SAME `now`.
            monkeypatch.setattr(task_ingest, "_last_unit_poll", 0.0)
            monkeypatch.setattr(task_ingest, "_last_sweep", 0.0)

            task = asyncio.create_task(task_ingest.ingest_loop())
            try:
                # Poll for the loop's own consequence instead of a fixed
                # sleep: the row must leave `running`, closed by whichever of
                # the follower/sweeper the loop's OWN body happened to run
                # first this pass.
                for _ in range(300):
                    row = task_registry.get("observed:unit:abc123")
                    if row is not None and row["state"] != "running":
                        break
                    await asyncio.sleep(0.01)
                # Give the same iteration's push-drain (and the harmless
                # start of a second, idle spin) time to run before inspecting.
                await asyncio.sleep(0.05)
            finally:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass

            row = task_registry.get("observed:unit:abc123")
            assert row is not None and row["state"] == "done"
            # The essential property: not "Lost track" then "Finished" —
            # exactly one push, and it is the honest one.
            assert len(sent) == 1
            assert sent[0]["title"] == "Finished"
        finally:
            unit_follower.reset_for_tests()
            task_push.reset_for_tests()

    asyncio.run(main())
