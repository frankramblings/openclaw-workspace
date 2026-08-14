import pytest

from backend import config, proc_tree, task_registry, unit_follower


@pytest.fixture(autouse=True)
def clean(monkeypatch):
    task_registry.reset_for_tests()
    unit_follower.reset_for_tests()
    monkeypatch.setattr(config, "OBSERVE_THRESHOLD_S", 6)
    monkeypatch.setattr(config, "UNIT_FOLLOWER_ENABLED", True)
    monkeypatch.setattr(proc_tree, "snapshot", lambda: {})
    yield
    task_registry.reset_for_tests()
    unit_follower.reset_for_tests()


def _units(monkeypatch, mapping):
    """mapping: unit name -> property dict, as systemd_units.show returns."""
    monkeypatch.setattr(unit_follower, "_list_active", lambda: list(mapping))
    monkeypatch.setattr(unit_follower, "_show", lambda names: dict(mapping))


JOB = {"Id": "podmigrate-readup.service", "Transient": "yes",
       "InvocationID": "abc123", "ActiveState": "active", "SubState": "running",
       "ExecMainPID": "4242", "ExecMainStatus": "0", "Result": "success",
       "Description": "[systemd-run] /bin/wsrun bash run-show.sh readup",
       "ActiveEnterTimestamp": ""}


def _exited(**over):
    out = {**JOB, "ActiveState": "inactive", "SubState": "dead",
           "ExecMainPID": "0"}
    out.update(over)
    return out


def test_an_installed_unit_is_never_followed(monkeypatch):
    _units(monkeypatch, {"openclaw-gateway.service":
                         {**JOB, "Id": "openclaw-gateway.service",
                          "Transient": "no", "InvocationID": "gw1"}})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1010.0)
    assert task_registry.list_tasks() == []


def test_a_transient_unit_below_the_threshold_gets_no_row(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1003.0)
    assert task_registry.list_tasks() == []


def test_a_transient_unit_past_the_threshold_gets_one_row(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"
    assert row["pct"] is None
    assert row["extra"]["pid"] == 4242
    assert row["extra"]["unit"] == "podmigrate-readup.service"
    assert row["extra"]["observed"] is True


def test_the_label_comes_from_the_description_without_systemds_prefix(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["label"] == "/bin/wsrun bash run-show.sh readup"


def test_a_unit_with_no_description_falls_back_to_its_name(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: {**JOB, "Description": ""}})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["label"] == "podmigrate-readup.service"


def test_an_idle_poll_writes_nothing(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    assert unit_follower.follow_once(now=1008.0) == 0
    assert unit_follower.follow_once(now=1009.0) == 0


def test_a_clean_exit_is_done_with_a_real_status(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {JOB["Id"]: _exited(ExecMainStatus="0", Result="success")})
    unit_follower.follow_once(now=1010.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "done"


def test_a_nonzero_exit_is_failed_not_interrupted(monkeypatch):
    # A unit hands us a REAL status, so this is knowledge, not inference.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {JOB["Id"]: _exited(ExecMainStatus="2",
                                            Result="exit-code")})
    unit_follower.follow_once(now=1010.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "failed"
    assert "2" in (row["detail"] or "")


def test_a_killed_unit_is_failed_and_says_how(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {JOB["Id"]: _exited(ExecMainStatus="0", Result="signal")})
    unit_follower.follow_once(now=1010.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "failed"
    assert "signal" in (row["detail"] or "")


def test_a_unit_that_vanishes_before_we_read_its_status_is_interrupted(monkeypatch):
    # `systemd-run --collect` garbage-collects a transient unit on exit, so
    # this is reachable: we watched it run and never saw an outcome.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {})
    unit_follower.follow_once(now=1010.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"
    assert "outcome unknown" in row["detail"]


def test_a_rerun_of_the_same_unit_name_is_a_new_row(monkeypatch):
    # bwg uses DELIBERATELY deterministic unit names, so this is the common
    # case, not an edge one.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {JOB["Id"]: _exited()})
    unit_follower.follow_once(now=1010.0)
    _units(monkeypatch, {JOB["Id"]: {**JOB, "InvocationID": "def456",
                                     "ExecMainPID": "5555"}})
    unit_follower.follow_once(now=1011.0)
    unit_follower.follow_once(now=1018.0)
    assert {r["id"] for r in task_registry.list_tasks()} == {
        "observed:unit:abc123", "observed:unit:def456"}


def test_the_subtree_carries_the_units_descendants_for_the_merge(monkeypatch):
    procs = {4242: {"ppid": 1, "starttime": 10, "cmdline": "run-show.sh"},
             4300: {"ppid": 4242, "starttime": 11, "cmdline": "archive_upload.py"},
             4301: {"ppid": 4300, "starttime": 12, "cmdline": "curl"}}
    monkeypatch.setattr(proc_tree, "snapshot", lambda: procs)
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    # A producer publishing ANY of these pids must attach to this row.
    assert sorted(row["extra"]["subtree"]) == [4242, 4300, 4301]


def test_a_growing_subtree_is_written_through(monkeypatch):
    procs = {4242: {"ppid": 1, "starttime": 10, "cmdline": "run-show.sh"}}
    monkeypatch.setattr(proc_tree, "snapshot", lambda: procs)
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    procs[4400] = {"ppid": 4242, "starttime": 20, "cmdline": "ffmpeg"}
    unit_follower.follow_once(now=1008.0)
    (row,) = task_registry.list_tasks()
    assert sorted(row["extra"]["subtree"]) == [4242, 4400]


def test_the_follower_is_skipped_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "UNIT_FOLLOWER_ENABLED", False)
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    assert task_registry.list_tasks() == []


def test_systemd_being_unavailable_is_silence_not_an_error(monkeypatch):
    monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
    monkeypatch.setattr(unit_follower, "_show", lambda _names: {})
    assert unit_follower.follow_once(now=1000.0) == 0
    assert task_registry.list_tasks() == []


def test_a_unit_listed_but_already_inactive_still_closes(monkeypatch):
    # list_active filters to active units, so in production a stopped unit
    # just stops appearing. It can also be listed and already inactive if it
    # exited between the two systemctl calls. Holding properties for a unit is
    # not evidence it is alive; only ActiveState is.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {JOB["Id"]: _exited(ExecMainStatus="0",
                                            Result="success")})
    unit_follower.follow_once(now=1010.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "done"


def test_a_unit_first_seen_already_dead_never_gets_a_row(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: _exited()})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1010.0)
    assert task_registry.list_tasks() == []
