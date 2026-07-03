"""fetch_history(strict=True) must distinguish a read FAILURE from an empty
transcript (raise, not silently return []) — the search reindexer relies on this
so a transient gateway blip can't be mistaken for an emptied session."""
import asyncio

import pytest

from backend import bridge


def test_nonstrict_returns_empty_on_request_error(monkeypatch):
    async def boom(method, params):
        raise ConnectionError("ws dead")
    monkeypatch.setattr(bridge, "_warm_request", boom)
    assert asyncio.run(bridge.fetch_history("k")) == {"history": [], "model": None}


def test_strict_raises_on_request_error(monkeypatch):
    async def boom(method, params):
        raise ConnectionError("ws dead")
    monkeypatch.setattr(bridge, "_warm_request", boom)
    with pytest.raises(RuntimeError):
        asyncio.run(bridge.fetch_history("k", strict=True))


def test_strict_raises_on_not_ok(monkeypatch):
    async def not_ok(method, params):
        return {"ok": False, "error": "nope"}
    monkeypatch.setattr(bridge, "_warm_request", not_ok)
    with pytest.raises(RuntimeError):
        asyncio.run(bridge.fetch_history("k", strict=True))
