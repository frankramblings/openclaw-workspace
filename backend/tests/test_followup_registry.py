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
