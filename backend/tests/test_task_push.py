import pytest

from backend import task_push


# House style for async tests in this suite (see test_inbox_undo_router.py):
# @pytest.mark.anyio plus this fixture, not pytest.mark.asyncio.
@pytest.fixture
def anyio_backend():
    return "asyncio"


def rec(tid="job:1", state="done", label="BwG 571 render"):
    return {"id": tid, "state": state, "label": label, "kind": "render",
            "session_key": "skey", "session_id": "sid", "error": ""}


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
