import pytest

from backend import config, observer, proc_tree, shell_hook, task_registry


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    task_registry.reset_for_tests()
    observer.reset_for_tests()
    monkeypatch.setattr(config, "OBSERVE_THRESHOLD_S", 6)
    monkeypatch.setattr(observer, "_session_key_for", lambda key: "chat-1")
    # Review finding 3: observe_once no longer calls the unit follower at all
    # (it now runs from ingest_loop on its own thread — see task_ingest), but
    # this flag stays here as a belt-and-suspenders guard against forking
    # real systemctl from this module's tests if that ever changes again.
    monkeypatch.setattr(config, "UNIT_FOLLOWER_ENABLED", False)
    yield
    task_registry.reset_for_tests()
    observer.reset_for_tests()


def _procs(*rows):
    return {pid: {"ppid": ppid, "starttime": st, "cmdline": cmd}
            for pid, ppid, st, cmd in rows}


SHELL = 100
# Spike shape A under the shell: three live processes, one job.
JOB = _procs((SHELL, 1, 10, "bash -i"),
             (200, SHELL, 20, "python3 bin/task run --id x"),
             (300, 200, 30, "bash -c sleep 16"),
             (400, 300, 40, "sleep 16"))
IDLE = _procs((SHELL, 1, 10, "bash -i"))


def _observe(monkeypatch, procs, now, envelopes=()):
    monkeypatch.setattr(observer, "_live_shells", lambda: {"term-1": SHELL})
    monkeypatch.setattr(proc_tree, "snapshot", lambda: procs)
    monkeypatch.setattr(observer, "_envelopes_for", lambda _key: list(envelopes))
    return observer.observe_once(now=now)


def test_a_short_lived_chain_never_gets_a_row(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1003.0)
    assert task_registry.list_tasks() == []


def test_a_chain_past_the_threshold_gets_exactly_one_row(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    rows = task_registry.list_tasks()
    assert len(rows) == 1
    row = rows[0]
    # Keyed on the shell's direct child, not on the pid bin/task publishes.
    assert row["id"] == "observed:200:20"
    assert row["state"] == "running"
    assert row["pct"] is None            # no denominator: spinner + elapsed
    assert row["session_key"] == "chat-1"
    assert row["extra"]["pid"] == 200
    assert sorted(row["extra"]["subtree"]) == [200, 300, 400]


def test_the_row_is_not_rewritten_on_every_poll(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    assert _observe(monkeypatch, JOB, now=1008.0) == 0
    assert _observe(monkeypatch, JOB, now=1009.0) == 0


def test_a_chain_that_grows_after_surfacing_updates_the_subtree(monkeypatch):
    # extra["subtree"] must not freeze at surfacing time: Task 5's merge
    # matches a producer's pid against this field, so a worker forked AFTER
    # the row exists (e.g. pid 500 under 400) still needs to land in it.
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    grown = _procs((SHELL, 1, 10, "bash -i"),
                   (200, SHELL, 20, "python3 bin/task run --id x"),
                   (300, 200, 30, "bash -c sleep 16"),
                   (400, 300, 40, "sleep 16"),
                   (500, 400, 45, "sleep 5"))
    assert _observe(monkeypatch, grown, now=1008.0) == 1
    (row,) = task_registry.list_tasks()
    assert sorted(row["extra"]["subtree"]) == [200, 300, 400, 500]


def test_an_unchanged_subtree_after_surfacing_still_writes_nothing(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    assert _observe(monkeypatch, JOB, now=1008.0) == 0
    assert _observe(monkeypatch, JOB, now=1009.0) == 0


def test_a_subtree_growth_write_does_not_clobber_a_producers_state(monkeypatch):
    # task_registry.upsert applies `state` and `detail` UNCONDITIONALLY on
    # every call (unlike label/pct/eta). A producer attaching to this row
    # (Task 5) owns both; the subtree-growth write must not stomp on either.
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.upsert(row["id"], kind="observed", source="observed",
                         detail="uploading to archive.org  ok=54 skip=0 err=0",
                         pct=0.42)
    grown = _procs((SHELL, 1, 10, "bash -i"),
                   (200, SHELL, 20, "python3 bin/task run --id x"),
                   (300, 200, 30, "bash -c sleep 16"),
                   (400, 300, 40, "sleep 16"),
                   (500, 400, 45, "sleep 5"))
    assert _observe(monkeypatch, grown, now=1008.0) == 1
    (row,) = task_registry.list_tasks()
    assert row["detail"] == "uploading to archive.org  ok=54 skip=0 err=0"
    assert row["pct"] == 0.42
    assert sorted(row["extra"]["subtree"]) == [200, 300, 400, 500]


def test_a_subtree_growth_write_does_not_resurrect_a_terminal_row(monkeypatch):
    # `bin/task` can write `done` while its wrapped process is still alive
    # for a moment. A subtree change landing in that window must not force
    # the row back to `running` — observers own existence and state, but
    # NOT once a producer has already closed the row out.
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.upsert(row["id"], kind="observed", source="observed",
                         state="done", detail="")
    grown = _procs((SHELL, 1, 10, "bash -i"),
                   (200, SHELL, 20, "python3 bin/task run --id x"),
                   (300, 200, 30, "bash -c sleep 16"),
                   (400, 300, 40, "sleep 16"),
                   (500, 400, 45, "sleep 5"))
    _observe(monkeypatch, grown, now=1008.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "done"


def test_a_vanished_chain_with_a_matching_envelope_reports_its_exit_code(monkeypatch):
    envelope = {"text": "bin/task run --id x", "start": 999.0, "end": 1010.0,
                "exit_code": 0, "bg_pid": None, "outcome_known": True}
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0, envelopes=[envelope])
    (row,) = task_registry.list_tasks()
    assert row["state"] == "done"


def test_a_nonzero_exit_code_is_a_failure(monkeypatch):
    envelope = {"text": "bin/task run --id x", "start": 999.0, "end": 1010.0,
                "exit_code": 2, "bg_pid": None, "outcome_known": True}
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0, envelopes=[envelope])
    (row,) = task_registry.list_tasks()
    assert row["state"] == "failed"


def test_a_vanished_chain_with_no_envelope_is_interrupted(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"
    assert "outcome unknown" in row["detail"]


def test_a_backgrounding_envelope_never_supplies_an_outcome(monkeypatch):
    # Spike shape B: the envelope closed in 1.1ms with exit 0 for an 18s job.
    envelope = {"text": "nohup x &", "start": 999.0, "end": 999.0011,
                "exit_code": 0, "bg_pid": 200, "outcome_known": False}
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0, envelopes=[envelope])
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"


def test_two_chains_inside_one_envelope_are_not_attributed(monkeypatch):
    two = _procs((SHELL, 1, 10, "bash -i"),
                 (200, SHELL, 20, "job one"),
                 (500, SHELL, 50, "job two"))
    envelope = {"text": "job one & job two", "start": 999.0, "end": 1010.0,
                "exit_code": 0, "bg_pid": None, "outcome_known": True}
    _observe(monkeypatch, two, now=1000.0)
    _observe(monkeypatch, two, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0, envelopes=[envelope])
    assert {r["state"] for r in task_registry.list_tasks()} == {"interrupted"}


def test_an_envelope_that_does_not_contain_the_chain_is_not_attributed(monkeypatch):
    envelope = {"text": "something else", "start": 1008.0, "end": 1009.0,
                "exit_code": 0, "bg_pid": None, "outcome_known": True}
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0, envelopes=[envelope])
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"


def test_a_dead_shell_interrupts_the_rows_it_owned(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    monkeypatch.setattr(observer, "_live_shells", lambda: {})
    monkeypatch.setattr(proc_tree, "snapshot", lambda: {})
    monkeypatch.setattr(observer, "_envelopes_for", lambda _key: [])
    observer.observe_once(now=1012.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"


# --- Final review, Important 4: the closing write must not weaken a --------
# --- confirmed outcome, nor blank a producer's last word ------------------
#
# `state` and `detail` always apply on an upsert, and the closing loop used
# to write both unconditionally. A row a pid-attached producer had already
# marked `done` — which `bin/task` does BEFORE its own process exits — was
# overwritten with `interrupted` and an empty detail the moment the chain
# vanished. The next scan re-corrects that on the ordinary path, two SSE
# frames later; it does not re-correct once the producer's file has aged
# past RETAIN_TERMINAL_S, or was removed by `bin/task rm`, or belongs to
# `bin/job` (whose ingest branch never merges).


def test_a_vanished_chain_does_not_overwrite_a_row_already_done(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.upsert(row["id"], kind="observed", source="observed",
                         state="done", detail="uploaded 54 files")
    # No envelope, so the observer's own reading of this ending is
    # "interrupted" — strictly weaker than the producer's confirmed `done`.
    assert _observe(monkeypatch, IDLE, now=1011.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["state"] == "done"
    assert row["detail"] == "uploaded 54 files"


def test_a_vanished_chain_does_not_overwrite_a_row_already_failed(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.upsert(row["id"], kind="observed", source="observed",
                         state="failed", detail="ffmpeg exited 1", error="boom")
    assert _observe(monkeypatch, IDLE, now=1011.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["state"] == "failed" and row["error"] == "boom"


def test_the_closing_write_keeps_the_producers_last_detail(monkeypatch):
    # Deferred minor from Task 4, folded in here: the row's outcome is ours
    # to state, but the context line is the producer's and is still true.
    envelope = {"text": "bin/task run --id x", "start": 999.0, "end": 1010.0,
                "exit_code": 0, "bg_pid": None, "outcome_known": True}
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.upsert(row["id"], kind="observed", source="observed",
                         state="running", detail="uploading  ok=54 skip=0 err=0")
    _observe(monkeypatch, IDLE, now=1011.0, envelopes=[envelope])
    (row,) = task_registry.list_tasks()
    assert row["state"] == "done"
    assert row["detail"] == "uploading  ok=54 skip=0 err=0"


def test_an_interrupted_close_still_replaces_a_stale_progress_line(monkeypatch):
    # The one case that must NOT carry the detail through: "87%, encoding"
    # under a row that says the process stopped reads as alive.
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.upsert(row["id"], kind="observed", source="observed",
                         state="running", detail="87%, encoding")
    _observe(monkeypatch, IDLE, now=1011.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"
    assert row["detail"] == "stopped; outcome unknown"


def test_a_closing_row_the_registry_no_longer_holds_is_not_recreated(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    (row,) = task_registry.list_tasks()
    task_registry.remove(row["id"])
    assert _observe(monkeypatch, IDLE, now=1011.0) == 0
    assert task_registry.list_tasks() == []


def test_a_recycled_pid_is_a_different_row(monkeypatch):
    _observe(monkeypatch, JOB, now=1000.0)
    _observe(monkeypatch, JOB, now=1007.0)
    _observe(monkeypatch, IDLE, now=1011.0)
    recycled = _procs((SHELL, 1, 10, "bash -i"),
                      (200, SHELL, 77, "a completely different command"))
    _observe(monkeypatch, recycled, now=1012.0)
    _observe(monkeypatch, recycled, now=1019.0)
    assert {r["id"] for r in task_registry.list_tasks()} == {
        "observed:200:20", "observed:200:77"}


def test_the_label_prefers_the_open_envelopes_command_text(monkeypatch):
    envelope = {"text": "bin/task run --label 'nightly render'", "start": 999.0,
                "end": None, "exit_code": None, "bg_pid": None,
                "outcome_known": False}
    _observe(monkeypatch, JOB, now=1000.0, envelopes=[envelope])
    _observe(monkeypatch, JOB, now=1007.0, envelopes=[envelope])
    (row,) = task_registry.list_tasks()
    assert row["label"] == "bin/task run --label 'nightly render'"


def test_an_empty_process_tree_makes_no_writes(monkeypatch):
    monkeypatch.setattr(observer, "_live_shells", lambda: {"term-1": SHELL})
    monkeypatch.setattr(proc_tree, "snapshot", lambda: {})
    monkeypatch.setattr(observer, "_envelopes_for", lambda _key: [])
    assert observer.observe_once(now=1000.0) == 0


# --- _envelopes_for: the real function, against a real log file ------------
#
# Every test above monkeypatches `_envelopes_for` away, so the incremental-
# tail-plus-whole-parse design, the 64 KB cap, and the `offset < prev` reset
# never actually run anywhere else. These two exercise the real thing.


def test_envelopes_for_pairs_a_start_and_end_line_across_two_reads(tmp_path, monkeypatch):
    path = tmp_path / "term-x.log"
    monkeypatch.setattr(shell_hook, "log_path", lambda _key: path)
    path.write_text("start\t1000.0\t1\t\techo hi\n")
    # First read: only the `start` line exists, so the command is still open.
    first = observer._envelopes_for("term-x")
    assert len(first) == 1
    assert first[0]["text"] == "echo hi"
    assert first[0]["end"] is None
    # The `end` line arrives on a LATER poll, appended to the same file. A
    # naive parse-each-chunk implementation would see only this line on the
    # second read and pair nothing; the bounded whole-buffer reparse must
    # still join it to the `start` line from the first read.
    with path.open("a") as f:
        f.write("end\t1001.0\t1\t\t0\n")
    second = observer._envelopes_for("term-x")
    assert len(second) == 1
    assert second[0]["text"] == "echo hi"
    assert second[0]["end"] == 1001.0
    assert second[0]["exit_code"] == 0
    assert second[0]["outcome_known"] is True


def test_envelopes_for_resets_when_the_log_is_replaced_by_a_shorter_one(tmp_path, monkeypatch):
    path = tmp_path / "term-y.log"
    monkeypatch.setattr(shell_hook, "log_path", lambda _key: path)
    path.write_text("start\t1000.0\t1\t\told long command that just finished\n"
                     "end\t1001.0\t1\t\t0\n")
    observer._envelopes_for("term-y")          # advance the offset past this file
    # A new shell for the same terminal key replaces the log with a shorter
    # one. The next read must reset the buffer to just the new content, not
    # return misaligned bytes (or silently concatenate stale + new text).
    path.write_text("start\t2000.0\t2\t\tnew cmd\n")
    result = observer._envelopes_for("term-y")
    assert len(result) == 1
    assert result[0]["text"] == "new cmd"
