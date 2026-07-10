import json
from pathlib import Path
import pytest

from backend import pending_tokens


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(pending_tokens.config, "DATA_DIR", tmp_path)
    yield tmp_path


def test_register_then_for_turn(store):
    tok = pending_tokens.register(
        "agent:main:web-abc", 42, kind="image",
        label="test prompt", source_ref="task-uuid-1")
    assert tok["kind"] == "image"
    assert tok["label"] == "test prompt"
    assert tok["source_ref"] == "task-uuid-1"
    assert len(tok["id"]) >= 16
    assert "spawned_at" in tok

    pending = pending_tokens.for_turn("agent:main:web-abc", 42)
    assert len(pending) == 1
    assert pending[0]["id"] == tok["id"]


def test_resolve_removes_and_returns_token(store):
    tok = pending_tokens.register(
        "agent:main:web-abc", 42, kind="image",
        label="p", source_ref="r")
    removed = pending_tokens.resolve(
        "agent:main:web-abc", 42, tok["id"], {"image_url": "x"})
    assert removed is not None
    assert removed["id"] == tok["id"]
    assert "elapsed_ms" in removed
    assert pending_tokens.for_turn("agent:main:web-abc", 42) == []


def test_resolve_missing_returns_none(store):
    assert pending_tokens.resolve("s", 1, "nope", {}) is None


def test_resolve_prunes_empty_turn_from_disk(store):
    tok = pending_tokens.register("s", 1, kind="image", label="l", source_ref="r")
    pending_tokens.resolve("s", 1, tok["id"], {})
    data = json.loads((store / "pending_tokens.json").read_text())
    assert data["turns"] == {}
