"""POST /api/session/branch — client-provided-prefix branch endpoint.

The client already rendered the prefix (it knows exactly which bubbles are
above the branch point) and sends it verbatim; the server trusts it, stashes
it via branch_context, and echoes it back. No bridge.fetch_history call, no
id lookup — see .superpowers/sdd/task-3-brief.md for why."""
import importlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from backend import branch_context, sessions_store
from backend.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated_branch_context_dir(monkeypatch):
    """Keep this test off the real .data/branch_context/ store (separate from
    the sessions_store isolation the shared conftest fixture already gives us
    — branch_context computes its own dir from __file__, not config.DATA_DIR)."""
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", tmp)
    importlib.reload(branch_context)


def test_branch_happy_path():
    src = sessions_store.create(name="src", model=None,
                                endpoint_url=None, endpoint_id=None, speed=None)
    prefix = [
        {"role": "user", "text": "hi"},
        {"role": "assistant", "text": "hello"},
    ]
    r = client.post("/api/session/branch", json={
        "source_session_id": src["id"],
        "prefix": prefix,
    })
    assert r.status_code == 200
    body = r.json()
    assert "session_id" in body and body["session_id"] != src["id"]
    assert body["prefix"] == prefix
    ctx = branch_context.read(body["session_id"])
    assert ctx is not None
    assert "hi" in ctx["preamble"]
    assert "hello" in ctx["preamble"]
    sessions_store.delete(src["id"])
    sessions_store.delete(body["session_id"])


def test_branch_missing_source_is_404():
    r = client.post("/api/session/branch", json={
        "source_session_id": "no-such-session",
        "prefix": [{"role": "user", "text": "hi"}],
    })
    assert r.status_code == 404


def test_branch_empty_prefix_is_400():
    src = sessions_store.create(name="src2", model=None,
                                endpoint_url=None, endpoint_id=None, speed=None)
    r = client.post("/api/session/branch", json={
        "source_session_id": src["id"],
        "prefix": [],
    })
    assert r.status_code == 400
    sessions_store.delete(src["id"])
