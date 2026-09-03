"""A freshly titled thread is handed to the auto-filer (spec §6.1) without
blocking the turn."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, config, project_classify, sessions_store
from backend.app import app


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


def test_new_thread_is_filed_after_title(monkeypatch):
    rec = sessions_store.create(name="New chat", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    filed = []

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kw):
        yield bridge._sse({"delta": "Kamino oMLX setup"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    async def fake_file(session_id, message=""):
        filed.append((session_id, message))
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)
    monkeypatch.setattr(project_classify, "file_session", fake_file)
    res = TestClient(app).post("/api/chat_stream", data={"message": "how do I run oMLX", "session": rec["id"]})
    assert res.status_code == 200
    assert filed and filed[0][0] == rec["id"] and "oMLX" in filed[0][1]
