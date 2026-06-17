"""Tests for the spinoff endpoint: bulk path (new) and single-item path (regression)."""
import asyncio
import pytest

from backend import inbox, sessions_store


# ---------------------------------------------------------------------------
# Shared helpers / monkeypatching
# ---------------------------------------------------------------------------

def _patch_spinoff(monkeypatch, tmp_path):
    """Redirect file-system side-effects and suppress the seeding agent turn."""
    monkeypatch.setattr(sessions_store, "_STORE_FILE", tmp_path / "sessions.json")
    seeded = []

    async def fake_turn(seed, key, model):
        seeded.append({"key": key, "seed": seed})

    monkeypatch.setattr(inbox, "_agent_turn", fake_turn)
    monkeypatch.setattr(inbox, "_log_spinoff", lambda *a, **k: None)
    return seeded


GMAIL_ITEM_1 = {
    "source": "gmail",
    "title": "Invoice 1",
    "subtitle": "a@x.com",
    "meta": {"uid": "1", "folder": "INBOX"},
}

GMAIL_ITEM_2 = {
    "source": "gmail",
    "title": "Invoice 2",
    "subtitle": "b@x.com",
    "meta": {"uid": "2", "folder": "INBOX"},
}


# ---------------------------------------------------------------------------
# Bulk path (the new feature)
# ---------------------------------------------------------------------------

def test_bulk_spinoff_creates_one_session(monkeypatch, tmp_path):
    """POST /api/items/spinoff with items list → one session, count == len(items)."""
    seeded = _patch_spinoff(monkeypatch, tmp_path)

    payload = {"items": [GMAIL_ITEM_1, GMAIL_ITEM_2]}
    result = asyncio.run(inbox.spinoff(payload))

    assert isinstance(result, dict), f"Expected dict, got: {result}"
    assert result.get("session_id"), "session_id must be truthy"
    assert result.get("count") == 2, f"count must be 2, got {result.get('count')}"
    assert len(seeded) == 1, "Bulk spinoff must seed exactly once"
    # The seed text should mention both titles
    seed_text = seeded[0]["seed"]
    assert "Invoice 1" in seed_text
    assert "Invoice 2" in seed_text


def test_bulk_spinoff_rejects_empty_list(monkeypatch, tmp_path):
    """items=[] (empty) is treated as missing → falls through to single-item path → 400."""
    _patch_spinoff(monkeypatch, tmp_path)

    # An empty list means no items → treated like no `items` key at all,
    # so the single-item path triggers and fails with "item.title is required".
    result = asyncio.run(inbox.spinoff({"items": []}))
    # JSONResponse body has ok=False or error key
    body = result.body if hasattr(result, "body") else None
    assert result.status_code == 400


def test_bulk_spinoff_rejects_items_without_titles(monkeypatch, tmp_path):
    """items with all-blank titles must return 400."""
    _patch_spinoff(monkeypatch, tmp_path)

    payload = {"items": [{"source": "gmail", "title": "", "subtitle": "a@x.com",
                          "meta": {"uid": "3"}}]}
    result = asyncio.run(inbox.spinoff(payload))
    assert result.status_code == 400


# ---------------------------------------------------------------------------
# Single-item path (regression)
# ---------------------------------------------------------------------------

def test_single_spinoff_still_works(monkeypatch, tmp_path):
    """The original single-item path must still succeed after the bulk branch is added."""
    seeded = _patch_spinoff(monkeypatch, tmp_path)

    # Non-reply path (no intent="reply") doesn't need IMAP
    item = {
        "source": "gmail",
        "title": "Invoice 1",
        "subtitle": "a@x.com",
        "snippet": "Please pay",
        "meta": {"uid": "1", "folder": "INBOX"},
    }
    result = asyncio.run(inbox.spinoff({"item": item}))

    assert isinstance(result, dict), f"Expected dict, got: {result}"
    assert result.get("session_id"), "session_id must be truthy"
    assert len(seeded) == 1, "Single spinoff must seed exactly once"
