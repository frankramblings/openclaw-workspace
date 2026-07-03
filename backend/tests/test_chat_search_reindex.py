"""Reindex regression tests:

  * incremental skip keys on the session `updated` stamp (so bumping it at turn
    end — what app.py now does — is what makes new messages searchable), and
  * a gateway read FAILURE (strict fetch raises) must NOT wipe a good index.
"""
import asyncio

import pytest

from backend import chat_search

HELLO = [
    {"role": "user", "content": "hello world this is a real question"},
    {"role": "assistant", "content": "and here is a substantive answer back"},
]


def _session(sid="s1", updated=100):
    return {"id": sid, "sessionKey": f"web-{sid}", "updated": updated,
            "name": "Chat", "archived": False}


@pytest.fixture
def search_env(tmp_path, monkeypatch):
    # _DB_PATH is bound at import from the (real) data dir; redirect it to tmp.
    monkeypatch.setattr(chat_search, "_DB_PATH", tmp_path / "chat_search.db")
    monkeypatch.setattr(chat_search, "_voyage_key", lambda: "test-key")

    async def fake_embed(texts, input_type):
        return [[1.0, 0.0, 0.0] for _ in texts]
    monkeypatch.setattr(chat_search, "_embed", fake_embed)
    return monkeypatch


def _with_sessions(monkeypatch, sessions):
    monkeypatch.setattr(chat_search.sessions_store, "list_sessions",
                        lambda: list(sessions))


def test_indexes_then_skips_unchanged(search_env, monkeypatch):
    sess = _session(updated=100)
    _with_sessions(monkeypatch, [sess])
    fetches = {"n": 0}

    async def fetch(key, limit=1000, strict=False):
        fetches["n"] += 1
        return {"history": HELLO, "model": None}
    monkeypatch.setattr(chat_search.bridge, "fetch_history", fetch)

    r1 = asyncio.run(chat_search.reindex())
    assert r1["sessions_indexed"] == 1
    assert chat_search.stats()["chunks"] == 2
    assert fetches["n"] == 1

    # Same `updated` → skipped, and we don't even fetch the transcript again.
    r2 = asyncio.run(chat_search.reindex())
    assert r2["sessions_indexed"] == 0 and r2["skipped"] == 1
    assert fetches["n"] == 1


def test_updated_bump_makes_a_new_turn_indexable(search_env, monkeypatch):
    sess = _session(updated=100)
    _with_sessions(monkeypatch, [sess])

    async def fetch(key, limit=1000, strict=False):
        return {"history": HELLO, "model": None}
    monkeypatch.setattr(chat_search.bridge, "fetch_history", fetch)

    asyncio.run(chat_search.reindex())
    sess["updated"] = 200          # what app.py bumps at turn end
    r = asyncio.run(chat_search.reindex())
    assert r["sessions_indexed"] == 1 and r["skipped"] == 0


def test_fetch_failure_does_not_wipe_index(search_env, monkeypatch):
    sess = _session(updated=100)
    _with_sessions(monkeypatch, [sess])

    async def ok(key, limit=1000, strict=False):
        return {"history": HELLO, "model": None}
    monkeypatch.setattr(chat_search.bridge, "fetch_history", ok)
    asyncio.run(chat_search.reindex())
    assert chat_search.stats()["chunks"] == 2

    # Stamp changes (forces a reindex attempt) but the gateway read fails.
    sess["updated"] = 200

    async def failing(key, limit=1000, strict=False):
        if strict:
            raise RuntimeError("gateway down")
        return {"history": [], "model": None}
    monkeypatch.setattr(chat_search.bridge, "fetch_history", failing)

    r = asyncio.run(chat_search.reindex())
    assert r["sessions_indexed"] == 0
    assert chat_search.stats()["chunks"] == 2   # survived — NOT wiped
