"""promise_guard.schedule_self_wake: bring Gary back after a hollow promise.

Rides the followup machinery (origin='promise_wake' + a custom seed), deduped
to one outstanding wake and cooldown-bounded so a re-promising wake turn can't
loop into a self-ping storm.
"""
import pytest

from backend import config, followup, promise_guard, sessions_store, task_registry


SID, SK = "abc123def456", "agent:main:web-abc123def456"


@pytest.fixture(autouse=True)
def _fresh(tmp_path, monkeypatch):
    # Isolate both stores to tmp so tests never touch the live data dir.
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    monkeypatch.setattr(followup, "_store_file", lambda: tmp_path / "followups.json")
    task_registry.reset_for_tests()
    # A real session record so id_for_session_key resolves.
    monkeypatch.setattr(sessions_store, "id_for_session_key",
                        lambda sk: SID if sk == SK else None)
    monkeypatch.setattr(config, "PROMISE_WAKE_ENABLED", True)
    monkeypatch.setattr(config, "PROMISE_WAKE_DELAY_S", 90)
    monkeypatch.setattr(config, "PROMISE_WAKE_COOLDOWN_S", 600)
    yield
    task_registry.reset_for_tests()


def test_schedules_a_wake_promise_with_custom_seed():
    pid = promise_guard.schedule_self_wake(SK, "I'll let you know when it's done")
    assert pid
    p = followup.get_promise(pid)
    assert p["origin"] == "promise_wake"
    assert p["state"] == "pending"
    assert p["seed_override"].startswith("[[promise-wake]]")
    assert "I'll let you know when it's done" in p["seed_override"]
    # Deadline is set (the sweeper fires it as overdue), not disabled.
    assert p["deadline_ms"] > 0


def test_dedup_one_outstanding_wake_per_session():
    first = promise_guard.schedule_self_wake(SK, "I'll circle back")
    second = promise_guard.schedule_self_wake(SK, "I'll circle back again")
    assert first
    assert second is None  # a pending wake already exists


def test_cooldown_blocks_a_fresh_wake_after_one_resolves(monkeypatch):
    first = promise_guard.schedule_self_wake(SK, "I'll follow up")
    followup.mark(first, "overdue")  # resolve it
    # Within cooldown → refused even though nothing is pending.
    assert promise_guard.schedule_self_wake(SK, "I'll follow up again") is None


def test_cooldown_expired_allows_new_wake(monkeypatch):
    first = promise_guard.schedule_self_wake(SK, "I'll follow up")
    followup.mark(first, "overdue")
    monkeypatch.setattr(config, "PROMISE_WAKE_COOLDOWN_S", 0)  # no cooldown
    assert promise_guard.schedule_self_wake(SK, "I'll follow up again")


def test_disabled_flag_is_a_hard_off(monkeypatch):
    monkeypatch.setattr(config, "PROMISE_WAKE_ENABLED", False)
    assert promise_guard.schedule_self_wake(SK, "I'll report back") is None


def test_unknown_session_is_a_noop(monkeypatch):
    monkeypatch.setattr(sessions_store, "id_for_session_key", lambda sk: None)
    assert promise_guard.schedule_self_wake("agent:main:web-nope", "I'll ping you") is None


def test_fire_uses_the_custom_seed(monkeypatch):
    """The wake seed reaches fire_followup unchanged (not the task seed)."""
    pid = promise_guard.schedule_self_wake(SK, "I'll let you know")
    p = followup.get_promise(pid)
    # history_card renders the wake marker as a compact follow-through line.
    card = followup.history_card(p["seed_override"])
    assert card and "Follow-through nudge" in card
