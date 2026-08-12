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
# launch_sniffer only learns the real pid AFTER create_promise already ran,
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

    # This is the seam launch_sniffer._watch_and_complete exercises right
    # after _find_pid resolves a real pid.
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


def test_reseed_registry_producer_ms_uses_created_not_a_fresh_now(monkeypatch):
    # A restart must not reset a stalled row's quiet clock: producer_ms has
    # to be the promise's own `created` stamp, never "now" at reseed time.
    rec = followup.create_promise("sid", "skey", "restart clock", 0)
    task_registry.reset_for_tests()
    monkeypatch.setattr(followup, "_now_ms", lambda: rec["created"] + 999_000)
    followup.reseed_registry()
    mirrored = task_registry.get(f"followup:{rec['id']}")
    assert mirrored["extra"]["producer_ms"] == rec["created"]
