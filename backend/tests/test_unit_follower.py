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
    # A real systemctl failure surfaces as _list_active() returning None (see
    # systemd_units.list_active), not []. [] is now a legitimate, actionable
    # answer -- "systemd was asked and nothing is active" -- so it no longer
    # stands in for "could not be asked at all".
    monkeypatch.setattr(unit_follower, "_list_active", lambda: None)
    monkeypatch.setattr(unit_follower, "_show", lambda _names: {})
    assert unit_follower.follow_once(now=1000.0) == 0
    assert task_registry.list_tasks() == []


def test_a_failing_systemctl_pass_leaves_an_existing_row_untouched(monkeypatch):
    # Review finding 2 (Important): list_active() returning [] used to mean
    # BOTH "confirmed nothing active" and "systemd is unreachable", so a
    # failed pass closed every tracked row as interrupted -- a guess dressed
    # as a confirmed ending. None is "no information this pass": leave
    # everything exactly as it was and write nothing.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "running"
    monkeypatch.setattr(unit_follower, "_list_active", lambda: None)
    assert unit_follower.follow_once(now=1008.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"


def test_a_deactivating_unit_is_not_closed_until_it_genuinely_stops(monkeypatch):
    # Review finding 1 (Critical): `systemctl list-units --state=active`
    # excludes ActiveState=deactivating for the unit's ENTIRE shutdown window
    # (up to TimeoutStopSec), so a unit dropping out of the active list is
    # NOT proof it has stopped. Its held properties can still report
    # Result=success/ExecMainStatus=0 from before the stop even started --
    # closing on that would report `done` for a unit that is still running.
    # Only a genuinely-stopped ActiveState may produce a terminal outcome.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
    # The re-check (batched show) still reports it alive.
    monkeypatch.setattr(unit_follower, "_show", lambda _names: {JOB["Id"]: JOB})
    assert unit_follower.follow_once(now=1008.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"
    # It survived the deactivating pass rather than being lost from _SEEN:
    # once it genuinely stops, the SAME row closes, not a fresh one.
    monkeypatch.setattr(unit_follower, "_show",
                        lambda _names: {JOB["Id"]: _exited(ExecMainStatus="0",
                                                            Result="success")})
    unit_follower.follow_once(now=1009.0)
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "done"


def test_the_closing_reshow_is_one_batched_call_not_one_per_unit(monkeypatch):
    # Review finding 4 (Important): the closing loop must fork systemctl at
    # most once per pass for units that need a fresh look, not once per
    # closing unit.
    two = {**JOB}
    other = {**JOB, "Id": "podmigrate-other.service", "InvocationID": "zzz999",
             "ExecMainPID": "9999"}
    _units(monkeypatch, {two["Id"]: two, other["Id"]: other})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    assert len(task_registry.list_tasks()) == 2
    monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
    calls = []

    def spy_show(names):
        calls.append(list(names))
        return {two["Id"]: _exited(ExecMainStatus="0", Result="success"),
                other["Id"]: _exited(**{**other, "ExecMainStatus": "0",
                                        "Result": "success",
                                        "ActiveState": "inactive",
                                        "SubState": "dead",
                                        "ExecMainPID": "0"})}
    monkeypatch.setattr(unit_follower, "_show", spy_show)
    unit_follower.follow_once(now=1008.0)
    assert len(calls) == 1
    assert set(calls[0]) == {two["Id"], other["Id"]}
    states = {r["id"]: r["state"] for r in task_registry.list_tasks()}
    assert states == {"observed:unit:abc123": "done", "observed:unit:zzz999": "done"}


def test_a_stopped_unit_with_no_result_evidence_is_interrupted_not_failed(monkeypatch):
    # Review finding 5 (Minor): with Result and ExecMainStatus both empty,
    # _outcome_for used to fall through to "failed" / "exited 0" -- a guess
    # in the direction that claims MORE than we know. No evidence means the
    # same "we don't know" outcome as a unit that vanished outright.
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    _units(monkeypatch, {JOB["Id"]: _exited(Result="", ExecMainStatus="")})
    unit_follower.follow_once(now=1010.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "interrupted"
    assert "outcome unknown" in row["detail"]


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


# --- Review round 2 -----------------------------------------------------
#
# Finding 1 (Important, regression from round 1's still-alive gate): the
# closing loop accepted `fresh.get(state["unit"])` as evidence about
# `invocation` without checking the properties actually belong to it. `bwg`
# and `podmigrate` reuse DETERMINISTIC unit names on purpose, so if the old
# invocation exits and a new run starts under the SAME name inside one
# UNIT_POLL_S window, a fresh look at that name is now about the NEW
# invocation -- accepting it as "still alive, don't close" stranded the OLD
# row at `running` forever, re-forking a `show` for it every pass.


def test_a_reused_unit_name_closes_the_old_invocation_not_the_new_one(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"
    # Same unit name, but `show()`'s answer for it is now about a brand new
    # invocation -- a fresh run replaced the old one inside this poll window.
    _units(monkeypatch, {JOB["Id"]: {**JOB, "InvocationID": "def456",
                                     "ExecMainPID": "5555"}})
    assert unit_follower.follow_once(now=1008.0) == 1   # A's close, this pass
    rows = {r["id"]: r for r in task_registry.list_tasks()}
    assert rows["observed:unit:abc123"]["state"] == "interrupted"
    assert "outcome unknown" in rows["observed:unit:abc123"]["detail"]
    # B accumulates under its own identity and, once past the threshold,
    # gets its own row -- proof this is a genuinely new row, not A revived.
    unit_follower.follow_once(now=1015.0)
    ids = {r["id"] for r in task_registry.list_tasks()}
    assert ids == {"observed:unit:abc123", "observed:unit:def456"}


# Findings 2/3 (Important): the None-vs-empty contract stopped one door
# short. `show()` collapsing a failed call to {} (finding 2) or `_run`
# reading a nonzero exit as an empty stdout (finding 3, fixed at the
# systemd_units layer -- see test_systemd_units.py) both turn a systemctl
# hiccup into "confirmed gone", closing every tracked unit `interrupted`.


def test_a_show_failure_during_the_main_pass_leaves_existing_rows_untouched(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "running"
    monkeypatch.setattr(unit_follower, "_list_active", lambda: [JOB["Id"]])
    monkeypatch.setattr(unit_follower, "_show", lambda _names: None)
    assert unit_follower.follow_once(now=1008.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"


def test_a_show_failure_during_the_closing_pass_leaves_the_entry_tracked(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    (row,) = task_registry.list_tasks()
    assert row["state"] == "running"
    # list_active answers honestly (the unit dropped out, e.g. deactivating),
    # but the SEPARATE closing-loop reshow fails outright.
    monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
    monkeypatch.setattr(unit_follower, "_show", lambda _names: None)
    assert unit_follower.follow_once(now=1008.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"
    # It survived rather than closing wrong: once systemd answers again with
    # a real outcome, the SAME row closes.
    monkeypatch.setattr(unit_follower, "_show",
                        lambda _names: {JOB["Id"]: _exited(ExecMainStatus="0",
                                                            Result="success")})
    unit_follower.follow_once(now=1009.0)
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "done"


# Finding 4 (Important): collect() is the blocking half (systemctl forks
# only, no registry access) and is what runs off the event-loop thread;
# apply() is the pure half (the whole state machine, every _SEEN mutation,
# every task_registry.upsert) and MUST run on the loop -- task_registry's
# own contract requires producers to call upsert from there (see its module
# docstring: _fanout's queue wakeups are not thread-safe). follow_once stays
# a thin collect()-then-apply() wrapper so this file's existing tests, which
# all call it directly and synchronously, need no other change.


# Finding C (Minor): _still_alive is an ALLOWLIST of confirmed-stopped
# states (inactive, failed), not a denylist of known-alive ones. systemd's
# ActiveState vocabulary is bigger than what this box has been observed
# reporting (systemd 259 here also reports "maintenance"/"refreshing"), and
# a value this module doesn't recognize must resolve toward "not yet
# confirmed stopped" rather than toward computing an outcome from properties
# that might still be mid-transition.


def test_an_unrecognized_activestate_is_not_treated_as_confirmed_stopped(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    unit_follower.follow_once(now=1000.0)
    unit_follower.follow_once(now=1007.0)
    monkeypatch.setattr(unit_follower, "_list_active", lambda: [])
    monkeypatch.setattr(unit_follower, "_show",
                        lambda _names: {JOB["Id"]: {**JOB, "ActiveState": "maintenance"}})
    assert unit_follower.follow_once(now=1008.0) == 0
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
    assert row["state"] == "running"


def test_collect_makes_no_registry_writes_only_apply_does(monkeypatch):
    _units(monkeypatch, {JOB["Id"]: JOB})
    collected = unit_follower.collect()
    assert task_registry.list_tasks() == []       # collect() wrote nothing
    unit_follower.apply(collected, 1000.0)
    assert task_registry.list_tasks() == []        # still under threshold
    collected = unit_follower.collect()
    assert task_registry.list_tasks() == []        # collect() STILL wrote nothing
    changed = unit_follower.apply(collected, 1007.0)
    assert changed == 1
    (row,) = task_registry.list_tasks()
    assert row["id"] == "observed:unit:abc123"
