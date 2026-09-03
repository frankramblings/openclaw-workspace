"""OPEN-shelf plumbing on the routes: a user send stamps `opened`, close clears
it, and a branch records its parent + inherits the project (spec §5)."""
import importlib
import tempfile

import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import branch_context, bridge, config, sessions_store
from backend.app import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    tmp = tempfile.mkdtemp()
    monkeypatch.setenv("OPENCLAW_BRANCH_CONTEXT_DIR", tmp)
    importlib.reload(branch_context)


def _mk(**kw):
    base = dict(name="t", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    base.update(kw)
    return sessions_store.create(**base)


def test_close_clears_opened_and_404s_unknown():
    rec = _mk()
    sessions_store.mark_opened(rec["id"])
    r = client.post(f"/api/session/{rec['id']}/close")
    assert r.status_code == 200 and r.json() == {"ok": True}
    assert sessions_store.get(rec["id"])["opened"] is None
    assert client.post("/api/session/nope/close").status_code == 404


def test_chat_stream_marks_opened(monkeypatch):
    rec = _mk(name="already titled")

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kw):
        yield bridge._sse({"delta": "ok"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)
    res = client.post("/api/chat_stream", data={"message": "hello", "session": rec["id"]})
    assert res.status_code == 200
    opened = sessions_store.get(rec["id"])["opened"]
    assert isinstance(opened, int) and opened > 0


def test_branch_records_parent_and_inherits_folder():
    src = _mk()
    sessions_store.update(src["id"], folder="p-1234abcd")
    r = client.post("/api/session/branch", json={
        "source_session_id": src["id"],
        "prefix": [{"role": "user", "text": "hi"}, {"role": "assistant", "text": "hello"}],
    })
    assert r.status_code == 200
    child = sessions_store.get(r.json()["session_id"])
    assert child["parent_id"] == src["id"]
    assert child["folder"] == "p-1234abcd"
    assert isinstance(child["opened"], int)
