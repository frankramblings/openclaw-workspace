"""Auto-registered launches ride the followup machinery (origin='auto') but
appear in the registry as kind='auto' with the originating ledger turn_id —
that's what lets task rows anchor deterministically and lets the promise
guard exclude auto tasks from "did anything register?" checks."""
import pytest

from backend import followup, task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


SID, SK = "abc123def456", "agent:main:web-abc123def456"


def test_default_origin_unchanged():
    rec = followup.create_promise(SID, SK, "render 566", 3600)
    assert rec["origin"] == "followup"
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["kind"] == "followup" and t["turn_id"] is None


def test_auto_origin_mirrors_kind_auto_with_turn_id():
    rec = followup.create_promise(SID, SK, "nohup render.sh", 14400,
                                  origin="auto", turn_id=42)
    assert rec["origin"] == "auto" and rec["turn_id"] == 42
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["kind"] == "auto"
    assert t["turn_id"] == 42


def test_reseed_preserves_kind_and_turn_id():
    rec = followup.create_promise(SID, SK, "nohup x", 14400,
                                  origin="auto", turn_id=7)
    task_registry.reset_for_tests()
    assert followup.reseed_registry() == 1
    t = task_registry.get(f"followup:{rec['id']}")
    assert t["kind"] == "auto" and t["turn_id"] == 7


def test_reseed_rearms_auto_watchers(monkeypatch):
    # A pending, unpinged auto promise from before a restart has no watcher
    # (asyncio Tasks don't survive a process boundary) — reseed_registry must
    # re-arm one, or it silently rides the 4h deadline backstop alone.
    from backend import launch_sniffer

    rec = followup.create_promise(SID, SK, "sleep 99", 14400, origin="auto")
    task_registry.reset_for_tests()
    calls = []
    monkeypatch.setattr(launch_sniffer, "rearm_watch",
                        lambda pid, label, session_key=None: calls.append((pid, label)))
    followup.reseed_registry()
    assert calls == [(rec["id"], "sleep 99")]


def test_reseed_does_not_rearm_pinged_or_non_auto(monkeypatch):
    # Pinged auto promises are already in the sweeper's recorded-but-unfired
    # path (due_promises fires them directly); non-auto (real followup)
    # promises were never sniffer-watched in the first place.
    from backend import launch_sniffer

    pinged = followup.create_promise(SID, SK, "sleep 1", 14400, origin="auto")
    followup.record_completion(pinged["id"], exit_code=0, duration_s=1.0, tail="")
    followup.create_promise(SID, SK, "render", 3600, origin="followup")
    task_registry.reset_for_tests()
    calls = []
    monkeypatch.setattr(launch_sniffer, "rearm_watch",
                        lambda pid, label, session_key=None: calls.append((pid, label)))
    followup.reseed_registry()
    assert calls == []


def test_reseed_count_excludes_failed_upserts(monkeypatch):
    followup.create_promise(SID, SK, "a", 3600)
    followup.create_promise(SID, SK, "b", 3600)

    def boom(*a, **k):
        raise OSError("disk full")

    monkeypatch.setattr(followup.task_registry, "upsert", boom)
    assert followup.reseed_registry() == 0
