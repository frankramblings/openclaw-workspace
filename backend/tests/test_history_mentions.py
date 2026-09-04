"""/api/history strips the mentions context block so the user sees their
own typed text, extending the existing websearch strip chain (app.py's
history handler already chains websearch.strip_context_block then
terminals.strip_capability_note)."""
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, mentions, sessions_store


def test_history_strips_mention_block(monkeypatch):
    rec = {"id": "abc123def456", "sessionKey": "k", "model": "openclaw"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)
    # Build the wrapped transcript entry the same way a real turn would have
    # stored it: mentions.context_block's output, followed by the marker and
    # the user's original text (see mentions.prepend_mentions, Task 1).
    original = "what's on my list? @[Groceries](note:n1)"
    block = mentions.context_block([
        mentions.ResolvedMention(kind="note", id="n1", title="Groceries",
                                 body="Milk, eggs.\n", truncated=False, missing=False),
    ])
    stored = block + mentions._CTX_MARKER + original

    async def fake_hist(session_key, limit=200, strict=False):
        return {"history": [
            {"role": "user", "content": stored},
            {"role": "assistant", "content": "Milk and eggs."},
        ], "model": None}

    monkeypatch.setattr(bridge, "fetch_history", fake_hist)
    client = TestClient(app_module.app)
    hist = client.get("/api/history/abc123def456").json()["history"]
    assert hist[0]["content"] == original
    assert hist[1]["content"] == "Milk and eggs."
