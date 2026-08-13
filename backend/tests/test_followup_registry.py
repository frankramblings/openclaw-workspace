"""Every followup promise is mirrored as a registry task so the unified feed
(and the in-chat rows) see background work the moment Gary registers it —
state transitions follow the promise lifecycle."""
import pytest

from backend import followup, task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


def _mk():
    return followup.create_promise("abc123def456", "agent:main:web-abc123def456",
                                   "render 566", 3600)


def test_create_promise_registers_running_task():
    rec = _mk()
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["kind"] == "followup" and t["state"] == "running"
    assert t["session_key"] == "agent:main:web-abc123def456"
    assert t["label"] == "render 566"


def test_completion_ping_updates_detail():
    rec = _mk()
    followup.record_completion(rec["id"], exit_code=0, duration_s=12.5, tail="ok")
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["state"] == "running"
    assert "exit 0" in t["detail"]


def test_mark_completed_is_done():
    rec = _mk()
    followup.record_completion(rec["id"], exit_code=0, duration_s=1.0, tail="")
    followup.mark(rec["id"], "completed")
    assert task_registry.get(f"followup:{rec['id']}")["state"] == "done"


def test_mark_failed_carries_error():
    rec = _mk()
    followup.mark(rec["id"], "failed", error="session missing or archived")
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["state"] == "failed" and "session missing" in t["error"]


def test_mirror_failure_never_breaks_promises(monkeypatch):
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(followup.task_registry, "upsert", boom)
    rec = _mk()                                    # create survives
    assert followup.record_completion(rec["id"], exit_code=0, duration_s=1.0, tail="")
    assert followup.mark(rec["id"], "completed") is not None


def test_reseed_registry_mirrors_pending_only():
    a = _mk()
    b = _mk()
    followup.mark(b["id"], "failed", error="x")
    task_registry.reset_for_tests()
    assert followup.reseed_registry() == 1
    assert task_registry.get(f"followup:{a['id']}")["state"] == "running"
    assert task_registry.get(f"followup:{b['id']}") is None


def test_mark_overdue_mirrors_failed_with_honest_error():
    rec = _mk()
    followup.mark(rec["id"], "overdue")
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["state"] == "failed"
    assert "never reported back" in t["error"]


def test_completion_mirror_recreated_with_origin_kind():
    rec = followup.create_promise("abc123def456", "agent:main:web-abc123def456",
                                  "nohup x", 14400, origin="auto")
    task_registry.reset_for_tests()          # simulate restart, pre-reseed
    followup.record_completion(rec["id"], exit_code=-1, duration_s=5.0, tail="")
    assert task_registry.get(f"followup:{rec['id']}")["kind"] == "auto"


def test_watch_pid_is_mirrored_onto_the_registry_record():
    from backend import followup, task_registry
    task_registry.reset_for_tests()
    rec = followup.create_promise("sid", "skey", "bwg 571 pull", 0, watch_pid=9191)
    assert rec["watch_pid"] == 9191
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["pid"] == 9191


def test_promise_without_watch_pid_carries_no_pid():
    from backend import followup, task_registry
    task_registry.reset_for_tests()
    rec = followup.create_promise("sid", "skey", "no pid", 0)
    assert rec["watch_pid"] is None
    assert "pid" not in (task_registry.get(f"followup:{rec['id']}")["extra"] or {})


# --- set_watch_pid: the seam that makes watch_pid load-bearing -------------
#
# A watched process's real pid is not always known when create_promise runs,
# so without this function the liveness sweeper never gets a pid to check
# for a followup row -- exactly how the original 16-hour "running, 0%"
# zombies survived. See test_followup_zombie_confirmed_dead_only_after_set_watch_pid
# below for the end-to-end proof.


def test_set_watch_pid_persists_and_mirrors():
    rec = _mk()
    assert followup.set_watch_pid(rec["id"], 5150) is True
    updated = followup.get_promise(rec["id"])
    assert updated["watch_pid"] == 5150
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["pid"] == 5150


def test_set_watch_pid_unknown_id_returns_false():
    assert followup.set_watch_pid("no-such-promise", 123) is False


def test_set_watch_pid_terminal_promise_returns_false():
    rec = _mk()
    followup.mark(rec["id"], "failed", error="x")
    assert followup.set_watch_pid(rec["id"], 123) is False
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert "pid" not in (mirrored["extra"] or {})


def test_set_watch_pid_does_not_alter_state():
    # Simulate the sweeper having already marked this row stalled -- a
    # careless upsert(..., state=) call (the default is "running") would
    # silently revive it. set_watch_pid must preserve whatever state the
    # registry mirror is currently in.
    rec = _mk()
    task_registry.upsert(f"followup:{rec['id']}", kind="followup", source="followup",
                         state="stalled", detail="no update in 47m")
    assert followup.set_watch_pid(rec["id"], 777) is True
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["state"] == "stalled"
    assert mirrored["extra"]["pid"] == 777


def test_followup_zombie_confirmed_dead_only_after_set_watch_pid():
    """THE regression test for the user's original zombie bug. A followup
    promise whose watched process is dead must reach `interrupted` through
    the REAL task_liveness.sweep_once() -- but only once set_watch_pid has
    actually told the registry which pid to check. Real promise, real dead
    pid (a reaped subprocess), real sweep_once -- no mocking of any of the
    three. Before set_watch_pid runs there is no pid on the row, so the
    sweeper has nothing to confirm against and must NOT claim death; silence
    proves nothing, per the invariant."""
    import subprocess

    from backend import task_liveness

    dead = subprocess.Popen(["true"])
    dead.wait()  # definitely-dead, definitely-reaped pid

    rec = followup.create_promise("sid", "skey", "bwg 571 pull", 0)

    # Before wiring: no pid on the row. Silence is not confirmation, so the
    # sweeper must leave it alone (not interrupted, not anything else).
    assert task_liveness.sweep_once() == 0
    assert task_registry.get(f"followup:{rec['id']}")["state"] == "running"

    # This is the seam a pid-discovering watcher exercises right after it
    # resolves the real pid for an already-created promise.
    assert followup.set_watch_pid(rec["id"], dead.pid) is True

    # Now the sweeper can confirm death for itself.
    changed = task_liveness.sweep_once()
    assert changed == 1
    assert task_registry.get(f"followup:{rec['id']}")["state"] == "interrupted"


# --- reseed_registry carries pid + producer_ms across a restart ------------


def test_reseed_registry_mirrors_pid_and_producer_ms():
    rec = followup.create_promise("sid", "skey", "with pid", 0, watch_pid=4242)
    task_registry.reset_for_tests()
    assert followup.reseed_registry() == 1
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["pid"] == 4242
    assert mirrored["extra"]["producer_ms"] == rec["created"]


def test_reseed_registry_omits_pid_key_when_watch_pid_absent():
    rec = followup.create_promise("sid", "skey", "no pid", 0)
    task_registry.reset_for_tests()
    followup.reseed_registry()
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert "pid" not in (mirrored["extra"] or {})


def test_set_watch_pid_is_a_noop_when_no_registry_row_exists():
    # Restart-shaped: the promise store survives, the in-memory registry
    # does not (RETAIN_TERMINAL_S pruning, or a restart before reseed).
    # set_watch_pid must not resurrect a bare row with no label/session_key
    # -- it should just persist the on-disk pid and skip the mirror.
    rec = _mk()
    task_registry.reset_for_tests()
    assert followup.set_watch_pid(rec["id"], 999) is True
    assert task_registry.get(f"followup:{rec['id']}") is None
    assert followup.get_promise(rec["id"])["watch_pid"] == 999


# --- Fix round 1 CRITICAL: a normally-completing watched process must not
# read as "lost track" -----------------------------------------------------
#
# record_completion leaves the registry mirror at state="running" (the
# follow-up turn is still pending) -- but upsert only ever .update()s
# `extra`, so a pid written by set_watch_pid can never be removed by a plain
# upsert. Left in place, the NEXT liveness sweep sees a pid that just
# legitimately exited, "confirms" it dead, and flips the row to
# `interrupted` -- claiming the task was lost track of when it actually
# succeeded. Worse: that terminal upsert claims task_push's (id, created)
# dedup key, so the LATER correct `done` transition (via mark()) gets
# deduped away -- the user's only notification says "lost track", never
# "finished". record_completion must retire the pid (extra={"pid": None})
# so a completed-but-not-yet-marked row reads as "no confirmation
# available" (routes to `stalled`, never `interrupted`), exactly like a
# row that never had a pid at all.


def test_record_completion_retires_the_pid():
    rec = _mk()
    followup.set_watch_pid(rec["id"], 4242)
    followup.record_completion(rec["id"], exit_code=0, duration_s=1.0, tail="ok")
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["pid"] is None


def test_completed_auto_task_never_reads_as_lost_track(monkeypatch):
    """THE critical regression: real dead pid (the watched process
    legitimately exited), real sweep_once(), real task_push dedup -- proves
    the full production trace the review found. A completed auto task must
    reach `done` WITHOUT ever passing through `interrupted`, and must
    produce exactly one push whose body describes completion, not loss."""
    import subprocess

    from backend import task_liveness, task_push

    # This promise is created and completed within the same millisecond, so
    # task_push's fast-success gate (MIN_SUCCESS_S) would otherwise decide the
    # push assertion below instead of the interrupted-vs-done question actually
    # under test. The gate has its own coverage in test_task_push.py.
    monkeypatch.setattr(task_push, "MIN_SUCCESS_S", 0.0)
    task_push.reset_for_tests()

    dead = subprocess.Popen(["true"])
    dead.wait()  # definitely-dead, definitely-reaped -- exactly what a
                 # normally-exited watched process looks like to the sweeper

    rec = followup.create_promise("sid", "skey", "bwg 571 pull", 0, origin="auto")
    followup.set_watch_pid(rec["id"], dead.pid)

    # The process the promise was watching exits normally -- this is what a
    # pid watcher's completion callback does the instant it sees the pid go
    # dead.
    followup.record_completion(rec["id"], exit_code=0, duration_s=5.0, tail="ok")

    # A sweep landing in the window before mark() fires must NOT claim
    # death for a row whose producer just reported success.
    task_liveness.sweep_once()
    assert task_registry.get(f"followup:{rec['id']}")["state"] != "interrupted"

    # The followup sweeper (or the /complete endpoint) eventually fires
    # mark() -- simulated directly here, matching fire_followup's own call.
    followup.mark(rec["id"], "completed")
    assert task_registry.get(f"followup:{rec['id']}")["state"] == "done"

    pushes = task_push.pending_for_tests()
    assert len(pushes) == 1
    body = pushes[0]["body"].lower()
    assert "finished" in body
    assert "lost track" not in body and "unknown" not in body


def test_reseed_registry_producer_ms_uses_created_not_a_fresh_now(monkeypatch):
    # A restart must not reset a stalled row's quiet clock: producer_ms has
    # to be the promise's own `created` stamp, never "now" at reseed time.
    rec = followup.create_promise("sid", "skey", "restart clock", 0)
    task_registry.reset_for_tests()
    monkeypatch.setattr(followup, "_now_ms", lambda: rec["created"] + 999_000)
    followup.reseed_registry()
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["producer_ms"] == rec["created"]


def test_reseed_registry_retires_pid_for_an_already_pinged_promise():
    # Restart-shaped instance of the SAME critical bug fixed above for
    # record_completion: a promise whose watched process already reported
    # completion (pinged) before the restart, but hasn't been mark()'d yet,
    # must not have its now-stale watch_pid carried forward by reseed. A
    # liveness sweep landing in the window between reseed_registry() and
    # the followup sweeper's own resolution of this promise must not
    # "confirm" a normal exit as death.
    rec = followup.create_promise("sid", "skey", "restart mid-flight", 3600,
                                  watch_pid=4242)
    followup.record_completion(rec["id"], exit_code=0, duration_s=1.0, tail="ok")
    task_registry.reset_for_tests()
    followup.reseed_registry()
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["pid"] is None


def test_reseed_registry_missing_created_does_not_invent_a_producer_ms():
    # A corrupt on-disk record with no `created` stamp must not produce an
    # absurd producer_ms of epoch-0 ("no update in Nh" for a brand-new row)
    # -- omit the key entirely and let the sweeper fall back to `updated`,
    # the same no-confirmation-available path every other producer-less
    # record already takes.
    rec = followup.create_promise("sid", "skey", "corrupt record", 0)
    with followup._LOCK:
        data = followup._load()
        for p in data["promises"]:
            if p["id"] == rec["id"]:
                del p["created"]
        followup._save(data)
    task_registry.reset_for_tests()
    followup.reseed_registry()
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert "producer_ms" not in (mirrored["extra"] or {})
