"""Pending tokens (deferred work: image gen etc.) mirror into the registry as
kind=deferred so the unified feed shows them; the pending system's own store,
HTTP surface, and chat-stream frames are unchanged. Its per-turn key is
turn_start_id space, so it lands in extra.turn_ref, never canonical turn_id."""
import pytest

from backend import pending_tokens, task_registry


@pytest.fixture(autouse=True)
def _fresh():
    task_registry.reset_for_tests()
    yield
    task_registry.reset_for_tests()


SK = "agent:main:web-abc123def456"


def test_register_mirrors_running_deferred():
    tok = pending_tokens.register_and_emit(SK, 41, kind="image_generate",
                                           label="sunset render",
                                           source_ref="img_1")
    rec = task_registry.get(f"pending:{tok['id']}")
    assert rec["kind"] == "deferred" and rec["state"] == "running"
    assert rec["session_key"] == SK
    assert rec["turn_id"] is None                 # ledger id unknown here
    assert rec["extra"]["turn_ref"] == 41         # pending-system id space


def test_resolve_marks_done():
    tok = pending_tokens.register_and_emit(SK, 41, kind="image_generate",
                                           label="sunset render",
                                           source_ref="img_1")
    pending_tokens.resolve_and_emit(SK, 41, tok["id"], {"url": "/x.png"})
    assert task_registry.get(f"pending:{tok['id']}")["state"] == "done"


def test_resolve_after_restart_creates_attributed_record():
    tok = pending_tokens.register_and_emit(SK, 41, kind="image_generate",
                                           label="sunset render", source_ref="r")
    task_registry.reset_for_tests()          # simulate restart: registry empty
    pending_tokens.resolve_and_emit(SK, 41, tok["id"], {"url": "/x.png"})
    rec = task_registry.get(f"pending:{tok['id']}")
    assert rec["state"] == "done"
    assert rec["label"] == "sunset render"
    assert rec["session_key"] == SK
    assert rec["extra"]["turn_ref"] == 41


def test_registry_failure_never_breaks_register(monkeypatch):
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(pending_tokens.task_registry, "upsert", boom)
    tok = pending_tokens.register_and_emit(SK, 41, kind="image_generate",
                                           label="x", source_ref="r")
    assert tok["id"]      # token creation + emit survived the mirror failure


def test_registry_failure_never_breaks_resolve(monkeypatch):
    tok = pending_tokens.register_and_emit(SK, 41, kind="image_generate",
                                           label="x", source_ref="r")
    def boom(*a, **k):
        raise OSError("disk full")
    monkeypatch.setattr(pending_tokens.task_registry, "upsert", boom)
    out = pending_tokens.resolve_and_emit(SK, 41, tok["id"], {"url": "/x.png"})
    assert out is not None                    # resolve + emit survived
