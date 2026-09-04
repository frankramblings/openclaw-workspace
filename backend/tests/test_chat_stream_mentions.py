"""Integration test: /api/chat_stream expands @mention tokens into a
citation context block before the turn reaches the brain, and the raw
message is unaffected when there are no mentions. Mirrors
test_chat_stream_draft.py's fake-bridge pattern; no gateway needed."""
import pytest
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, config, terminals
from backend.app import app


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


def test_mention_token_is_expanded_before_the_brain_sees_it(vault_notes, monkeypatch):
    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kwargs):
        sent["message"] = message
        yield bridge._sse({"delta": "got it"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    client = TestClient(app)
    res = client.post("/api/chat_stream", data={
        "message": "what's on my list? @[Groceries](note:n1)", "session": "",
    })
    assert res.status_code == 200
    assert "── Note: Groceries ──" in sent["message"]
    assert "Milk, eggs." in sent["message"]
    assert sent["message"].endswith(
        "\n\n---\n\nUser message (mentions resolved above): "
        "what's on my list? @[Groceries](note:n1)")


def test_message_without_mentions_is_unchanged(monkeypatch):
    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kwargs):
        sent["message"] = message
        yield bridge._sse({"delta": "hi"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)
    # Isolate from chat_turn.py's unrelated Gary-drive terminal-control note
    # (on by default, prepended downstream of this route): this test's exact
    # equality check is about mentions leaving a mention-free message alone,
    # not about that separate capability hint. Same isolation convention as
    # test_terminals_mcp.py.
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: False)

    client = TestClient(app)
    res = client.post("/api/chat_stream", data={"message": "hello Gary", "session": ""})
    assert res.status_code == 200
    assert sent["message"] == "hello Gary"


def test_mention_of_missing_note_never_breaks_the_turn(monkeypatch):
    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None, run_info=None, **kwargs):
        sent["message"] = message
        yield bridge._sse({"delta": "ok"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    client = TestClient(app)
    res = client.post("/api/chat_stream", data={
        "message": "see @[Ghost](note:nope)", "session": "",
    })
    assert res.status_code == 200
    assert "── Note: Ghost (not found) ──" in sent["message"]
