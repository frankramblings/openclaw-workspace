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
