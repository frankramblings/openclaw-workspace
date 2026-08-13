import pytest

from backend import config, observer, proc_tree, task_registry


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    task_registry.reset_for_tests()
    observer.reset_for_tests()
    monkeypatch.setattr(config, "OBSERVE_THRESHOLD_S", 6)
    monkeypatch.setattr(observer, "_session_key_for", lambda key: "chat-1")
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


def test_observe_once_survives_an_unreadable_proc(monkeypatch):
    monkeypatch.setattr(observer, "_live_shells", lambda: {"term-1": SHELL})
    monkeypatch.setattr(proc_tree, "snapshot", lambda: {})
    monkeypatch.setattr(observer, "_envelopes_for", lambda _key: [])
    assert observer.observe_once(now=1000.0) == 0
