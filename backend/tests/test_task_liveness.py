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
    # sweep_once's return value can be nonzero here even without a revival —
    # an already-stalled row's detail text is legitimately refreshed on
    # every sweep now (Important-3) — so the assertion that matters is on
    # STATE, not on the changed count.
    tl.sweep_once(now_ms=2000)
    assert task_registry.get("followup:recycled")["state"] == "stalled"


# --- Round-1 review fixes -------------------------------------------------
#
# Critical-1: the sweeper's own writes used to destroy the quiet-time
# evidence it reasons from. `task_registry.upsert` bumps `rec["updated"]`
# on EVERY call, including the sweeper's own upserts — so when `next_state`
# read `rec["updated"]` as the quiet clock, a live-but-silent job would
# oscillate stalled -> running -> stalled forever: mark it stalled (which
# bumps `updated`), see `updated` as "fresh" next sweep, flip it straight
# back to running. Producers now stamp `extra["producer_ms"]` at write time;
# the sweeper reads that instead and never writes it.


def test_quiet_clock_falls_back_to_updated_when_producer_ms_absent():
    assert tl._quiet_clock_ms({"updated": 12345, "extra": {}}) == 12345
    assert tl._quiet_clock_ms({"updated": 12345, "extra": {"producer_ms": 999}}) == 999
    assert tl._quiet_clock_ms({"updated": 12345, "extra": None}) == 12345


def test_sweeping_twice_does_not_flap_a_live_but_silent_producer():
    # THE regression test for Critical-1. 23 previous tests never caught
    # this because none of them called sweep_once twice. A live pid
    # (os.getpid()) plus a producer_ms stamped far in the past: the process
    # is genuinely alive, but its producer has not reported in ages.
    #
    # now_ms is deliberately REAL wall-clock time (not a synthetic value):
    # `task_registry.upsert` always stamps `updated` from the real clock
    # internally, regardless of what `now_ms` sweep_once is called with, so
    # only a real-time-based test can reproduce the actual flap — the bug
    # was that the sweeper's OWN upsert (real time T) reads back as "fresh"
    # on the very next sweep tick (real time T + a few ms), even though the
    # producer itself has been silent the whole time.
    from backend import task_registry
    task_registry.reset_for_tests()
    now_ms = int(time.time() * 1000)
    old_ms = now_ms - int((tl.STALE_S + 100) * 1000)  # ~130s in the past
    task_registry.upsert("followup:silent", kind="followup", source="followup",
                         label="silent but alive", state="running", pct=0.0,
                         extra={"pid": os.getpid(), "producer_ms": old_ms})
    # Backdate `updated` too, so the FIRST sweep's staleness verdict is
    # identical whichever clock is consulted — the two clocks only diverge
    # starting from the first sweep's own write. This isolates the
    # regression to the second sweep, exactly where the real bug lived.
    task_registry._TASKS["followup:silent"]["updated"] = old_ms
    tl.sweep_once(now_ms=now_ms)
    assert task_registry.get("followup:silent")["state"] == "stalled"
    # Second sweep, moments later in real time (milliseconds have passed,
    # nowhere near STALE_S). If the sweeper's own upsert had fed the quiet
    # clock (the bug), `rec["updated"]` would now read as fresh — it was
    # just bumped to real "now" by the first sweep's own upsert above — and
    # this would flip straight back to "running". Because the clock is
    # producer_ms, untouched by the sweeper, it must still read as stale
    # and stay "stalled".
    tl.sweep_once(now_ms=int(time.time() * 1000))
    assert task_registry.get("followup:silent")["state"] == "stalled"


# --- Important-3: a stalled row's detail must keep growing ----------------


def test_stalled_detail_refreshes_as_quiet_time_grows():
    from backend import task_registry
    task_registry.reset_for_tests()
    now_ms = 100_000_000
    old_producer_ms = now_ms - int((tl.STALE_S + 60) * 1000)
    task_registry.upsert("followup:stale", kind="followup", source="followup",
                         label="old", state="stalled", pct=0.0,
                         extra={"producer_ms": old_producer_ms},
                         detail="no update in 1m")
    later_ms = now_ms + 10 * 60_000  # 10 minutes further on
    changed = tl.sweep_once(now_ms=later_ms)
    rec = task_registry.get("followup:stale")
    assert rec["state"] == "stalled"
    assert rec["detail"] != "no update in 1m"
    assert changed == 1


# --- Important-4: a zombie pid must not read as confirmed alive -----------


def test_confirm_alive_treats_a_real_zombie_as_unknown():
    # A REAL zombie: fork a child that exits immediately without the parent
    # reaping it. os.kill(pid, 0) succeeds for a zombie (it still occupies a
    # pid table slot) so pid_alive alone would say True — a false "alive"
    # claim for a process that has already exited.
    child_pid = os.fork()
    if child_pid == 0:
        os._exit(0)
        return  # pragma: no cover - unreachable, satisfies linters
    try:
        deadline = time.time() + 2.0
        is_zombie = False
        while time.time() < deadline:
            text = tl._read_proc_stat_text(child_pid)
            if text is not None and tl._parse_state_field(text) == "Z":
                is_zombie = True
                break
            time.sleep(0.01)
        assert is_zombie, "child did not reach zombie state in time"
        assert tl._confirm_alive(child_pid, created_ms=int(time.time() * 1000)) is None
    finally:
        os.waitpid(child_pid, 0)  # reap it — must not leak a zombie into the suite


# --- Minor-5: a non-numeric pid must not abort the whole sweep ------------


def test_sweep_skips_bad_pid_without_aborting_other_rows():
    from backend import task_registry
    task_registry.reset_for_tests()
    p = subprocess.Popen(["true"])
    p.wait()
    task_registry.upsert("followup:badpid", kind="followup", source="followup",
                         label="bad pid", state="running", pct=0.0,
                         extra={"pid": "not-a-pid"})
    task_registry.upsert("followup:deadpid", kind="followup", source="followup",
                         label="dead pid", state="running", pct=0.0,
                         extra={"pid": p.pid})
    changed = tl.sweep_once()  # must not raise despite the non-numeric pid
    assert task_registry.get("followup:deadpid")["state"] == "interrupted"
    # The bad-pid row was reached and evaluated (not skipped by an abort):
    # alive=None (no confirmation either way) and it's fresh, so next_state
    # correctly declines to change it.
    assert task_registry.get("followup:badpid")["state"] == "running"
    assert changed == 1


def test_an_observed_row_without_a_producer_never_goes_stalled():
    # `stalled` means "observed alive, producer quiet" (spec). An observed row
    # with no producer attached has no producer to be quiet — sending it to
    # stalled would print "no update in 4m" about a job nobody is narrating.
    row = {"id": "observed:200:20", "source": "observed", "state": "running",
           "created": 0, "updated": 0, "extra": {"pid": 200, "observed": True}}
    assert tl.next_state(row, now_ms=10_000_000, alive=True) is None


def test_an_observed_row_with_a_producer_attached_still_stalls():
    row = {"id": "observed:200:20", "source": "observed", "state": "running",
           "created": 0, "updated": 0,
           "extra": {"pid": 200, "observed": True, "producer_ms": 0}}
    assert tl.next_state(row, now_ms=10_000_000, alive=True) == "stalled"


def test_an_observed_row_whose_pid_is_confirmed_gone_still_interrupts():
    row = {"id": "observed:200:20", "source": "observed", "state": "running",
           "created": 0, "updated": 0, "extra": {"pid": 200, "observed": True}}
    assert tl.next_state(row, now_ms=10_000_000, alive=False) == "interrupted"


def test_an_observed_row_that_reached_stalled_can_return_to_running():
    # The gate above returns early for an observed row with no producer, but
    # a row that DID reach "stalled" (e.g. before a producer attached, or via
    # some other path) must still be able to recover once the process tree
    # reconfirms it alive — the early return must not swallow the existing
    # stalled -> running recovery for observed rows.
    row = {"id": "observed:200:20", "source": "observed", "state": "stalled",
           "created": 0, "updated": 0, "extra": {"pid": 200, "observed": True}}
    assert tl.next_state(row, now_ms=10_000_000, alive=True) == "running"
