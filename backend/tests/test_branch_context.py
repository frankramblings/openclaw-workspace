import pytest
import tempfile
import importlib

@pytest.fixture
def bc(monkeypatch):
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", tmp)
    from backend import branch_context
    importlib.reload(branch_context)
    return branch_context

def test_write_then_read_roundtrips(bc):
    prefix = [{"id": "m1", "role": "user", "text": "hi"}]
    bc.write("new-1", "src-1", prefix, "prior: hi")
    got = bc.read("new-1")
    assert got is not None
    assert got["source_session_id"] == "src-1"
    assert got["prefix"] == prefix
    assert got["preamble"] == "prior: hi"

def test_read_missing_returns_none(bc):
    assert bc.read("nope") is None

def test_consume_returns_and_deletes(bc):
    bc.write("new-2", "src-2", [], "p")
    first = bc.consume("new-2")
    second = bc.consume("new-2")
    assert first is not None
    assert second is None

def test_consume_missing_returns_none(bc):
    assert bc.consume("nope") is None
