"""/api/history strips the mentions context block so the user sees their
own typed text, extending the existing websearch strip chain (app.py's
history handler chains terminals.strip_capability_note, then
websearch.strip_context_block, then mentions.strip_context_block, outer to
inner, matching drive_turn's real nesting order in chat_turn.py)."""
from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, mentions, sessions_store, terminals, websearch


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


def test_history_strips_terminal_note_then_websearch_then_mentions(monkeypatch):
    """Production nesting order (drive_turn, chat_turn.py:490-530): mentions
    expand first (in chat_stream, before drive_turn runs), so the mentions
    block sits innermost around the user's typed text; websearch's block
    wraps that when the turn used web search; the terminal-control note is
    prepended OUTERMOST, on every turn where Gary-mode is on for the session
    (the default). /api/history must strip all three, outer to inner, or an
    earlier layer's start-anchored strip never gets a chance to match."""
    rec = {"id": "abc123def456", "sessionKey": "k", "model": "openclaw"}
    monkeypatch.setattr(sessions_store, "get",
                        lambda sid: rec if sid == rec["id"] else None)

    original = "what's on my list? @[Groceries](note:n1)"
    mentions_block = mentions.context_block([
        mentions.ResolvedMention(kind="note", id="n1", title="Groceries",
                                 body="Milk, eggs.\n", truncated=False, missing=False),
    ])
    mentions_wrapped = mentions_block + mentions._CTX_MARKER + original
    ws_results = [{"title": "Groceries near me", "url": "https://example.com/g",
                  "snippet": "local grocery listings"}]
    ws_wrapped = websearch.context_block(mentions_wrapped, ws_results)
    stored = terminals.gary_capability_note("k") + ws_wrapped

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
