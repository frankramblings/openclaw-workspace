import json
import pytest

from backend import strip_state


@pytest.fixture
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(strip_state.config, "DATA_DIR", tmp_path)
    yield tmp_path


def test_get_empty_session_returns_empty(store):
    assert strip_state.get("agent:main:web-abc") == []


def test_set_then_get_roundtrip(store):
    tasks = [{"id": 1, "subject": "Do thing", "status": "in_progress"}]
    strip_state.set("agent:main:web-abc", tasks)
    result = strip_state.get("agent:main:web-abc")
    assert result == tasks


def test_overwrite_replaces_tasks(store):
    strip_state.set("agent:main:web-abc", [{"id": 1, "subject": "old"}])
    strip_state.set("agent:main:web-abc", [{"id": 2, "subject": "new"}])
    result = strip_state.get("agent:main:web-abc")
    assert len(result) == 1
    assert result[0]["subject"] == "new"


def test_clear_removes_session(store):
    strip_state.set("agent:main:web-abc", [{"id": 1}])
    strip_state.clear("agent:main:web-abc")
    assert strip_state.get("agent:main:web-abc") == []


def test_clear_nonexistent_is_noop(store):
    strip_state.clear("agent:main:web-nonexistent")
    assert strip_state.get("agent:main:web-nonexistent") == []


def test_multiple_sessions_isolated(store):
    strip_state.set("agent:main:web-aaa", [{"id": 1}])
    strip_state.set("agent:main:web-bbb", [{"id": 2}])
    assert strip_state.get("agent:main:web-aaa") == [{"id": 1}]
    assert strip_state.get("agent:main:web-bbb") == [{"id": 2}]
    strip_state.clear("agent:main:web-aaa")
    assert strip_state.get("agent:main:web-aaa") == []
    assert strip_state.get("agent:main:web-bbb") == [{"id": 2}]


def test_updated_at_written_to_disk(store):
    strip_state.set("agent:main:web-abc", [])
    data = json.loads((store / "strip_state.json").read_text())
    rec = data["sessions"]["agent:main:web-abc"]
    assert "updated_at" in rec
    assert rec["updated_at"].endswith("Z")
