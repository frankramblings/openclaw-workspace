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


def test_image_attachments_rehydrate_on_a_mention_turn(vault_notes, tmp_path,
                                                       monkeypatch):
    """The attachment sidecar matches on the stored text against the DISPLAY
    content /api/history renders, so it must record what the user typed, not
    the mentions-wrapped message the brain sees. Otherwise a picture sent with
    a mention silently vanishes on reload."""
    from backend import attachments as att_module
    from backend import sessions_store

    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    up = tmp_path / "uploads"
    up.mkdir()
    (up / "img1.png").write_bytes(b"\x89PNG\r\n\x1a\n fake")
    monkeypatch.setattr(att_module, "ATTACH_DIR", up)
    monkeypatch.setattr(att_module, "_CHAT_ATTACH_DIR", tmp_path / "chat-att")

    rec = {"id": "abc123def456", "sessionKey": "k", "model": "openclaw",
           "name": "Chat"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    monkeypatch.setattr(sessions_store, "update", lambda *a, **k: rec)
    monkeypatch.setattr(sessions_store, "mark_opened", lambda *a, **k: None)

    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None,
                               run_info=None, **kwargs):
        sent["message"] = message
        yield bridge._sse({"delta": "ok"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    typed = "what is this? @[Groceries](note:n1)"
    client = TestClient(app)
    res = client.post("/api/chat_stream", data={
        "message": typed, "session": rec["id"], "attachments": '["img1.png"]',
    })
    assert res.status_code == 200

    async def fake_hist(session_key, limit=200, strict=False):
        return {"history": [{"role": "user", "content": sent["message"]}],
                "model": None}

    monkeypatch.setattr(bridge, "fetch_history", fake_hist)
    hist = client.get(f"/api/history/{rec['id']}").json()["history"]
    assert hist[0]["content"] == typed
    assert [a["id"] for a in hist[0].get("attachments") or []] == ["img1.png"]


def test_new_thread_title_comes_from_the_users_line_not_the_block(vault_notes,
                                                                  monkeypatch):
    """A fresh thread opened with a mention must be named after the question,
    not after the injected block's first line."""
    from backend import sessions_store

    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    rec = {"id": "abc123def456", "sessionKey": "k", "model": "openclaw",
           "name": "New chat"}
    names = []
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    monkeypatch.setattr(sessions_store, "mark_opened", lambda *a, **k: None)

    def fake_update(sid, **kw):
        if "name" in kw:
            names.append(kw["name"])
        return rec
    monkeypatch.setattr(sessions_store, "update", fake_update)

    async def fake_stream_turn(message, session_key=None, model_ref=None,
                               run_info=None, **kwargs):
        yield bridge._sse({"delta": "ok"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    async def no_ai_title(message):
        return ""

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)
    monkeypatch.setattr(app_module, "_generate_ai_title", no_ai_title)

    client = TestClient(app)
    res = client.post("/api/chat_stream", data={
        "message": "what's on my list? @[Groceries](note:n1)",
        "session": rec["id"],
    })
    assert res.status_code == 200
    assert names and names[0].startswith("what's on my list?")
