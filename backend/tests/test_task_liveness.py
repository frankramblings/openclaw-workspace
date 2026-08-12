from backend import task_liveness as tl

STALE_MS = int(tl.STALE_S * 1000)


def rec(state="running", quiet_ms=0, pid=None, now=1_000_000):
    r = {"id": "t:1", "kind": "render", "source": "taskfile", "state": state,
         "updated": now - quiet_ms, "extra": {}}
    if pid:
        r["extra"]["pid"] = pid
    return r


def test_confirmed_dead_becomes_interrupted():
    assert tl.next_state(rec(quiet_ms=STALE_MS + 1), 1_000_000, alive=False) == "interrupted"


def test_confirmed_dead_is_interrupted_even_while_still_fresh():
    # A process that exits without writing a terminal status is gone whether
    # or not it wrote recently. There is nothing to wait for.
    assert tl.next_state(rec(quiet_ms=0), 1_000_000, alive=False) == "interrupted"


def test_silence_without_a_pid_never_claims_death():
    # THE asymmetry. No pid means no confirmation, and no confirmation means
    # we say "stalled", not "interrupted" — however long the silence runs.
    for quiet in (STALE_MS + 1, STALE_MS * 100, STALE_MS * 100_000):
        assert tl.next_state(rec(quiet_ms=quiet), 1_000_000, alive=None) == "stalled"


def test_quiet_but_alive_is_stalled_not_interrupted():
    assert tl.next_state(rec(quiet_ms=STALE_MS + 1), 1_000_000, alive=True) == "stalled"


def test_alive_and_fresh_needs_no_change():
    assert tl.next_state(rec(quiet_ms=0), 1_000_000, alive=True) is None


def test_recovered_producer_returns_to_running():
    assert tl.next_state(rec(state="stalled", quiet_ms=0), 1_000_000, alive=True) == "running"


def test_terminal_records_are_never_touched():
    for state in ("done", "failed", "interrupted"):
        assert tl.next_state(rec(state=state, quiet_ms=STALE_MS * 10), 1_000_000, alive=False) is None


def test_pid_alive_reports_true_for_this_process():
    import os
    assert tl.pid_alive(os.getpid()) is True


def test_pid_alive_reports_false_for_a_reaped_pid():
    import subprocess
    p = subprocess.Popen(["true"])
    p.wait()
    assert tl.pid_alive(p.pid) is False


def test_sweep_marks_a_dead_followup_interrupted():
    from backend import task_registry
    task_registry.reset_for_tests()
    import subprocess
    p = subprocess.Popen(["true"])
    p.wait()
    task_registry.upsert("followup:zombie", kind="followup", source="followup",
                         label="bwg 571 pull", state="running", pct=0.0,
                         extra={"pid": p.pid})
    assert tl.sweep_once() == 1
    assert task_registry.get("followup:zombie")["state"] == "interrupted"


# --- pid recycling: a stateless identity check on top of pid_alive --------
#
# `os.kill(pid, 0)` cannot distinguish the process this record started from a
# LATER, unrelated process the OS recycled onto the same pid number. A dead
# job whose pid got recycled would otherwise read as alive forever — a false
# "alive" claim, exactly what the honest-progress invariant forbids. These
# tests cover the identity check (`pid_matches_record`), its low-level parser
# (`_parse_starttime_ticks`, including the comm-field hazard), and the glue
# that combines it with `pid_alive` (`_confirm_alive`) so sweep_once never
# calls a recycled pid "confirmed alive".
import os
import subprocess
import time


def test_parse_starttime_ticks_handles_comm_with_spaces_and_parens():
    # Field 2 (comm) can itself contain spaces AND parentheses. Parsing must
    # split on the LAST ')' in the line, or a name like "(weird (name) proc)"
    # misreads every field after it, including field 22 (starttime).
    fields_after_comm = ["S", "1", "1", "1", "0", "-1", "0", "0", "0", "0",
                          "0", "0", "0", "0", "0", "20", "0", "1", "0", "424242"]
    line = "999 (weird (name) proc) " + " ".join(fields_after_comm) + "\n"
    assert tl._parse_starttime_ticks(line) == 424242


def test_parse_starttime_ticks_returns_none_with_no_closing_paren():
    assert tl._parse_starttime_ticks("garbage, no parens here") is None


def test_parse_starttime_ticks_returns_none_when_truncated():
    assert tl._parse_starttime_ticks("999 (x) S 1 1") is None


def test_pid_matches_record_true_for_this_process():
    # A real, live process: its actual start time is necessarily before
    # "now", so it matches a record created now.
    now_ms = int(time.time() * 1000)
    assert tl.pid_matches_record(os.getpid(), now_ms) is True


def test_pid_matches_record_false_when_start_postdates_record():
    # Simulated recycling: a `created` stamp near the epoch cannot be when
    # THIS process — which is definitely running right now — started.
    assert tl.pid_matches_record(os.getpid(), created_ms=1000) is False


def test_pid_matches_record_unknown_for_a_reaped_pid():
    p = subprocess.Popen(["true"])
    p.wait()
    assert tl.pid_matches_record(p.pid, created_ms=int(time.time() * 1000)) is None


def test_pid_matches_record_unknown_when_stat_unreadable(monkeypatch):
    monkeypatch.setattr(tl, "_read_proc_stat_text", lambda pid: None)
    assert tl.pid_matches_record(os.getpid(), created_ms=int(time.time() * 1000)) is None


def test_pid_matches_record_unknown_when_stat_malformed(monkeypatch):
    monkeypatch.setattr(tl, "_read_proc_stat_text", lambda pid: "no parens at all")
    assert tl.pid_matches_record(os.getpid(), created_ms=int(time.time() * 1000)) is None


def test_pid_matches_record_unknown_when_boot_time_unreadable(monkeypatch):
    monkeypatch.setattr(tl, "_boot_time_epoch", lambda: None)
    assert tl.pid_matches_record(os.getpid(), created_ms=int(time.time() * 1000)) is None


def test_confirm_alive_treats_a_recycled_pid_as_unknown_not_alive():
    # The composition sweep_once relies on: a pid that EXISTS but fails the
    # identity check must never read as confirmed alive.
    assert tl._confirm_alive(os.getpid(), created_ms=1000) is None


def test_confirm_alive_passes_through_confirmed_death():
    p = subprocess.Popen(["true"])
    p.wait()
    assert tl._confirm_alive(p.pid, created_ms=int(time.time() * 1000)) is False


def test_confirm_alive_is_none_with_no_pid():
    assert tl._confirm_alive(None, created_ms=int(time.time() * 1000)) is None


def test_sweep_does_not_revive_a_stalled_task_via_a_recycled_pid():
    # The concrete failure this task exists to prevent: a producer's file
    # goes quiet, the sweeper marks the row stalled, and the OS later hands
    # that same pid number to something else. Without the identity check,
    # `pid_alive` alone would say True and the row would flip back to
    # "running" forever — a false alive claim about a dead job.
    from backend import task_registry
    task_registry.reset_for_tests()
    task_registry.upsert("followup:recycled", kind="followup", source="followup",
                         label="old followup", state="stalled", pct=0.0,
                         extra={"pid": os.getpid()})
    # Force `created` far into the past so this real, live process's actual
    # start time can't be it — simulating the record's original pid owner
    # having exited and the OS later recycling this pid onto something else.
    task_registry._TASKS["followup:recycled"]["created"] = 1000
    task_registry._TASKS["followup:recycled"]["updated"] = 1000
    assert tl.sweep_once(now_ms=2000) == 0
    assert task_registry.get("followup:recycled")["state"] == "stalled"
