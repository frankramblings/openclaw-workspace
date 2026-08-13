import asyncio

import pytest

from backend import push, task_push


# House style for async tests in this suite (see test_inbox_undo_router.py):
# @pytest.mark.anyio plus this fixture, not pytest.mark.asyncio.
@pytest.fixture
def anyio_backend():
    return "asyncio"


def rec(tid="job:1", state="done", label="BwG 571 render", created=None,
        updated=None):
    return {"id": tid, "state": state, "label": label, "kind": "render",
            "session_key": "skey", "session_id": "sid", "error": "",
            "created": created, "updated": updated}


def slow(tid="job:1", state="done", **kw):
    """A record whose run is comfortably longer than MIN_SUCCESS_S, so the
    fast-success gate is not what any given test is measuring."""
    return rec(tid, state, created=1_000_000,
               updated=1_000_000 + int((task_push.MIN_SUCCESS_S + 60) * 1000), **kw)


def test_done_queues_once():
    task_push.reset_for_tests()
    assert task_push.on_terminal(rec()) is True
    assert task_push.on_terminal(rec()) is False       # idempotent
    assert len(task_push.pending_for_tests()) == 1


def test_failed_and_interrupted_both_queue():
    task_push.reset_for_tests()
    assert task_push.on_terminal(rec("job:2", "failed")) is True
    assert task_push.on_terminal(rec("job:3", "interrupted")) is True
    assert len(task_push.pending_for_tests()) == 2


def test_running_never_queues():
    task_push.reset_for_tests()
    assert task_push.on_terminal(rec("job:4", "running")) is False
    assert task_push.on_terminal(rec("job:5", "stalled")) is False
    assert task_push.pending_for_tests() == []


def test_interrupted_copy_does_not_claim_failure():
    task_push.reset_for_tests()
    task_push.on_terminal(rec("job:6", "interrupted"))
    body = task_push.pending_for_tests()[0]["body"]
    assert "unknown" in body.lower()
    assert "fail" not in body.lower()


def test_boot_warmup_suppresses_the_restart_stampede():
    # sweep_boot() marks every orphaned task `interrupted` at startup. One
    # restart must not fire one notification per orphaned row.
    task_push.reset_for_tests(warm=False)
    assert task_push.on_terminal(rec("job:9", "interrupted")) is False
    assert task_push.pending_for_tests() == []


def test_a_warmup_suppressed_task_never_notifies_later_either():
    task_push.reset_for_tests(warm=False)
    task_push.on_terminal(rec("job:10", "interrupted"))
    task_push.reset_for_tests(warm=True)   # clears _PUSHED as well
    # A fresh registration of the SAME id after warmup is a genuinely new event
    # and does notify; the point is that the boot-time one never queued.
    assert task_push.on_terminal(rec("job:10", "done")) is True


@pytest.mark.anyio
async def test_drain_sends_and_empties_the_queue(monkeypatch):
    calls = []

    async def fake_send(payload):
        calls.append(payload)
        return {"sent": 1}

    monkeypatch.setattr(task_push.push, "send", fake_send)
    task_push.reset_for_tests()
    task_push.on_terminal(rec("job:7", "done"))
    assert await task_push.drain() == 1
    assert task_push.pending_for_tests() == []
    assert calls[0]["title"] == "Finished"


@pytest.mark.anyio
async def test_drain_swallows_send_failures(monkeypatch):
    async def boom(payload):
        raise RuntimeError("no network")

    monkeypatch.setattr(task_push.push, "send", boom)
    task_push.reset_for_tests()
    task_push.on_terminal(rec("job:8", "done"))
    assert await task_push.drain() == 0
    assert task_push.pending_for_tests() == []   # dropped, not retried forever


# --- Fix round 1: double push, badge wipe, dedup race, recurring ids --------


def test_badge_reflects_real_unseen_count(monkeypatch):
    """The payload's badge must be push.unseen_count() (chat_turn.py:670's
    pattern), never a hardcoded 0 — sw.js clears the app badge on any push
    whose `badge` is falsy, so a hardcoded 0 would wipe a real unseen count
    every time an unrelated task finished."""
    task_push.reset_for_tests()
    monkeypatch.setattr(task_push.push, "unseen_count", lambda: 7)
    task_push.on_terminal(rec("job:11", "done"))
    assert task_push.pending_for_tests()[0]["badge"] == 7


def test_recurring_task_id_notifies_again_on_a_new_run():
    """bin/task accepts a caller-supplied --id, and real production ids are
    stable and timestamp-free (pm-upload-ldwm, pm-upload-stvt). Keying
    _PUSHED on the bare id would silently and permanently suppress every
    notification for such an id after its first-ever run. Keying on
    (id, created) instead: same run (same `created`) suppresses; a genuinely
    new run (a fresh `created`, stamped when the registry reinserts the row
    after the old one aged out) notifies again."""
    task_push.reset_for_tests()
    assert task_push.on_terminal(rec("pm-upload-ldwm", "done", created=1000)) is True
    # Same id, same run -> suppressed, not a new event.
    assert task_push.on_terminal(rec("pm-upload-ldwm", "done", created=1000)) is False
    # Same id, new run (different `created`) -> genuinely new event, notifies.
    assert task_push.on_terminal(rec("pm-upload-ldwm", "done", created=2000)) is True
    assert len(task_push.pending_for_tests()) == 2


@pytest.mark.anyio
async def test_followup_terminal_transition_queues_exactly_one_push(monkeypatch):
    """followup.mark() must reach a push through ONLY the registry ->
    task_push hook now. The deleted code additionally spawned its own
    push.send fire-and-forget from _notify_followup_completion, producing
    TWO banners for one completion (different tags, so the service worker
    couldn't collapse them). Async (not a plain `def` test) so the old
    code's asyncio.create_task spawn actually gets a chance to run inside a
    real event loop — a sync test can't observe it (create_task raises with
    no running loop, and that raise was swallowed by the try/except this
    function is wrapped in), which is exactly how the double-push bug
    shipped without a test catching it."""
    from backend import followup

    send_calls = []

    async def spy_send(payload):
        send_calls.append(payload)
        return {"sent": 1}

    monkeypatch.setattr(push, "send", spy_send)
    # This test is about push ROUTING (one hook, not two), not about the
    # fast-success duration gate — the promise it drives resolves instantly, so
    # disable the gate rather than have it silently decide the assertion.
    # The gate itself is covered by test_a_fast_success_does_not_notify below.
    monkeypatch.setattr(task_push, "MIN_SUCCESS_S", 0.0)
    task_push.reset_for_tests()

    promise = followup.create_promise("session-1", "session-key-1", "spec test", 0)
    followup.mark(promise["id"], "completed", exit_code=0, duration_s=1.0)
    # Give any (erroneously) spawned fire-and-forget task a chance to run.
    await asyncio.sleep(0)
    await asyncio.sleep(0)

    assert len(task_push.pending_for_tests()) == 1
    assert send_calls == []  # followup no longer sends its own push directly


def test_pushed_lock_prevents_a_concurrent_double_enqueue():
    """The check-then-add on _PUSHED must be atomic: two 'concurrent' terminal
    upserts of the same (id, run) must never both enqueue. Simulated by
    racing on_terminal from two threads against a barrier, repeated many
    times to make a missed race window likely to surface."""
    import threading

    for _ in range(200):
        task_push.reset_for_tests()
        barrier = threading.Barrier(2)
        results: list[bool] = []
        results_lock = threading.Lock()

        def go():
            barrier.wait()
            outcome = task_push.on_terminal(rec("job:race", "done", created=1))
            with results_lock:
                results.append(outcome)

        threads = [threading.Thread(target=go) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert results.count(True) == 1
        assert len(task_push.pending_for_tests()) == 1


# --- Fix round 2: badge ordering ---------------------------------------------


# --- FINAL review, important 2: the first terminal state must not silence the
# --- authoritative one ---------------------------------------------------------


def test_a_real_exit_status_supersedes_lost_track():
    """Within ONE ingest_loop iteration: scan_once reads a still-running file,
    the process writes `done` and exits, sweep_once confirms the pid dead and
    upserts `interrupted` (push "Lost track" claims the key), then 0.5s later
    the terminal-file exemption applies `done`. Keying on the id alone meant
    the WRONG content was the only push a successful job ever produced."""
    task_push.reset_for_tests()
    assert task_push.on_terminal(slow("job:up", "interrupted")) is True
    assert task_push.on_terminal(slow("job:up", "done")) is True
    titles = [p["title"] for p in task_push.pending_for_tests()]
    assert titles == ["Lost track", "Finished"]


def test_lost_track_never_supersedes_a_real_exit_status():
    task_push.reset_for_tests()
    assert task_push.on_terminal(slow("job:down", "done")) is True
    assert task_push.on_terminal(slow("job:down", "interrupted")) is False
    assert len(task_push.pending_for_tests()) == 1


def test_exactly_one_upgrade_then_the_key_is_closed():
    task_push.reset_for_tests()
    assert task_push.on_terminal(slow("job:once", "interrupted")) is True
    assert task_push.on_terminal(slow("job:once", "failed")) is True
    assert task_push.on_terminal(slow("job:once", "done")) is False
    assert task_push.on_terminal(slow("job:once", "failed")) is False
    assert len(task_push.pending_for_tests()) == 2


def test_a_repeated_interrupted_is_not_an_upgrade():
    task_push.reset_for_tests()
    assert task_push.on_terminal(slow("job:same", "interrupted")) is True
    assert task_push.on_terminal(slow("job:same", "interrupted")) is False
    assert len(task_push.pending_for_tests()) == 1


def test_an_upgrade_pushes_even_for_a_fast_success():
    """The duration gate must not strand a user on a false "Lost track"
    banner: the correction always goes out, however short the run was."""
    task_push.reset_for_tests()
    fast = dict(created=1_000_000, updated=1_000_500)   # 0.5s
    assert task_push.on_terminal(rec("job:fastup", "interrupted", **fast)) is True
    assert task_push.on_terminal(rec("job:fastup", "done", **fast)) is True
    assert [p["title"] for p in task_push.pending_for_tests()] == ["Lost track", "Finished"]


# --- FINAL review, important 4b: minimum-duration gate, SUCCESS only ----------


def test_a_fast_success_does_not_notify():
    task_push.reset_for_tests()
    assert task_push.on_terminal(
        rec("job:quick", "done", created=1_000_000, updated=1_000_000 + 5_000)) is False
    assert task_push.pending_for_tests() == []


def test_a_slow_success_notifies():
    task_push.reset_for_tests()
    assert task_push.on_terminal(slow("job:long", "done")) is True


def test_a_fast_failure_always_notifies():
    """Asymmetric on purpose: a problem is worth knowing about immediately,
    a fast success is noise."""
    task_push.reset_for_tests()
    assert task_push.on_terminal(
        rec("job:boom", "failed", created=1_000_000, updated=1_000_100)) is True
    assert task_push.on_terminal(
        rec("job:gone", "interrupted", created=1_000_000, updated=1_000_100)) is True
    assert len(task_push.pending_for_tests()) == 2


def test_an_undateable_success_is_never_suppressed_on_a_guess():
    """No `updated` (or no `created`) means we do not know the duration. The
    invariant runs both ways: we do not claim it was fast either."""
    task_push.reset_for_tests()
    assert task_push.on_terminal(rec("job:nodur", "done")) is True
    task_push.reset_for_tests()
    assert task_push.on_terminal(rec("job:nocreate", "done", updated=1_000_000)) is True


def test_a_suppressed_fast_success_never_notifies_later_either():
    task_push.reset_for_tests()
    fast = dict(created=1_000_000, updated=1_000_500)
    assert task_push.on_terminal(rec("job:q2", "done", **fast)) is False
    assert task_push.on_terminal(rec("job:q2", "done", **fast)) is False
    assert task_push.pending_for_tests() == []


def test_followup_push_carries_the_post_increment_badge(monkeypatch):
    """The queued push's badge must be the count AFTER mark_unseen ran for
    THIS completion, not before. Deliberately does NOT monkeypatch
    push.unseen_count (unlike test_badge_reflects_real_unseen_count above) —
    by construction that test can never observe an ordering bug between
    mark_unseen and the registry upsert that reaches task_push. This one
    drives the real followup.mark() path end to end against an isolated
    DATA_DIR (backend/tests/conftest.py's autouse _isolated_data_dir), the
    same way the round-2 review reproduced the bug."""
    from backend import followup

    # Badge ORDERING is what's under test; the promise resolves instantly, so
    # the fast-success gate (MIN_SUCCESS_S) is disabled here rather than left
    # to silently decide the assertion. It is covered on its own below.
    monkeypatch.setattr(task_push, "MIN_SUCCESS_S", 0.0)
    task_push.reset_for_tests()
    promise = followup.create_promise("session-1", "session-key-1", "badge test", 0)
    followup.mark(promise["id"], "completed", exit_code=0, duration_s=1.0)

    queued = task_push.pending_for_tests()
    assert len(queued) == 1
    assert queued[0]["badge"] == push.unseen_count()
    assert queued[0]["badge"] == 1  # the one followup just marked unseen
