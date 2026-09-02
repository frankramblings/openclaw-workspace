import asyncio

import pytest

from backend import changes, chat_turn


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_begin_calls_changes_in_thread_and_never_raises(monkeypatch):
    seen = []
    monkeypatch.setattr(changes, "turn_started", lambda sk, tid: seen.append((sk, tid)))
    await chat_turn.changes_begin("sk", 4)
    assert seen == [("sk", 4)]

    def boom(sk, tid):
        raise RuntimeError("disk")
    monkeypatch.setattr(changes, "turn_started", boom)
    await chat_turn.changes_begin("sk", 5)          # no raise


@pytest.mark.anyio
async def test_begin_is_bounded(monkeypatch):
    import time as _t
    monkeypatch.setattr(chat_turn, "CHANGES_TIMEOUT_S", 0.05)
    monkeypatch.setattr(changes, "turn_started", lambda sk, tid: _t.sleep(0.5))
    t0 = asyncio.get_event_loop().time()
    await chat_turn.changes_begin("sk", 6)
    assert asyncio.get_event_loop().time() - t0 < 0.4


@pytest.mark.anyio
async def test_end_later_waits_then_calls(monkeypatch):
    seen = []
    monkeypatch.setattr(changes, "turn_ended", lambda sk, tid: seen.append((sk, tid)) or {})
    task = chat_turn.changes_end_later("sk", 7, delay=0.01)
    await task
    assert seen == [("sk", 7)]
    assert task not in chat_turn._CHANGES_TASKS
