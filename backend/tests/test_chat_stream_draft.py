"""Integration test: a doc-bound /api/chat_stream turn wraps the message and
emits doc_update before [DONE]. The bridge is faked; no gateway needed."""
import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, documents
from backend.app import app


def _events(sse_text: str) -> list:
    out = []
    for line in sse_text.splitlines():
        if not line.startswith("data: "):
            continue
        body = line[6:]
        try:
            out.append(json.loads(body))
        except ValueError:
            out.append(body)  # the [DONE] marker
    return out


def test_doc_bound_turn_wraps_and_emits_doc_update(vault_docs, monkeypatch):
    doc = vault_docs()
    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None):
        sent["message"] = message
        p = documents._path(doc["id"])
        text = p.read_text(encoding="utf-8")
        p.write_text(text.replace("First draft.", "Agent draft."), encoding="utf-8")
        yield bridge._sse({"delta": "Tightened the intro."})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    client = TestClient(app)
    res = client.post("/api/chat_stream",
                      data={"message": "tighten the intro", "session": "",
                            "active_doc_id": doc["id"]})
    assert res.status_code == 200
    events = _events(res.text)

    # The brain saw the draft-mode note + the original ask.
    assert "[draft mode]" in sent["message"]
    assert sent["message"].endswith("tighten the intro")

    updates = [e for e in events if isinstance(e, dict) and e.get("type") == "doc_update"]
    assert len(updates) == 1
    assert "Agent draft." in updates[0]["content"]
    assert updates[0]["version"] == 2
    # doc_update lands before the final [DONE].
    assert events.index(updates[0]) < len(events) - 1
    assert events[-1] == "[DONE]"
    # Undo exists: the pre-turn body was snapshotted.
    snap = documents.VERSIONS_DIR / doc["id"] / "v1.md"
    assert "First draft." in snap.read_text(encoding="utf-8")


def test_turn_without_doc_unchanged(monkeypatch):
    async def fake_stream_turn(message, session_key=None, model_ref=None):
        assert "[draft mode]" not in message
        yield bridge._sse({"delta": "hi"})

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    client = TestClient(app)
    res = client.post("/api/chat_stream", data={"message": "hello", "session": ""})
    assert res.status_code == 200
    assert "doc_update" not in res.text
    assert "[DONE]" in res.text
