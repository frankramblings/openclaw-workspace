"""Two 'never silently dropped' rules: a busy session defers a follow-up
(sweeper retries) instead of failing it, and a deadline-0 promise that goes
quiet forever at least LOOKS stalled in the registry."""
import time

import pytest

from backend import followup, task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


SID, SK = "abc123def456", "agent:main:web-abc123def456"


def test_busy_cap_before_deadline_leaves_pending():
    rec = followup.create_promise(SID, SK, "render", 4 * 3600)
    followup.record_completion(rec["id"], exit_code=0, duration_s=1.0, tail="")
    followup._busy_cap_reached(rec["id"])
    p = followup.get_promise(rec["id"])
    assert p["state"] == "pending"          # sweeper will retry


def test_busy_cap_past_deadline_fails():
    rec = followup.create_promise(SID, SK, "render", 1)   # 1s deadline
    followup.record_completion(rec["id"], exit_code=0, duration_s=1.0, tail="")
    time.sleep(1.1)
    followup._busy_cap_reached(rec["id"])
    p = followup.get_promise(rec["id"])
    assert p["state"] == "failed" and "busy past deadline" in p["error"]


def test_deadline_zero_surfaces_stalled_once():
    rec = followup.create_promise(SID, SK, "forever", 0)
    # Age the promise past the surfacing threshold.
    with followup._LOCK:
        data = followup._load()
        for p in data["promises"]:
            if p["id"] == rec["id"]:
                p["created"] -= (followup.STALL_SURFACE_S * 1000 + 1000)
        followup._save(data)
    followup.surface_stalled()
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["state"] == "stalled"
    # Second pass is a no-op (no duplicate fanout churn): updated unchanged.
    before = t["updated"]
    followup.surface_stalled()
    assert task_registry.get(f"followup:{rec['id']}")["updated"] == before
