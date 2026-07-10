"""record_turn must bracket every turn with turn_start/turn_end frames (with
the durable turn id) so clients get explicit boundaries instead of inferring
them from [DONE] — and so Stop (aborted) and a crashed source (error) are
distinguishable from success. turn_end always lands BEFORE [DONE]."""
import asyncio
import json

import pytest

from backend import bridge, chat_turn, event_store, turn_state


def _frames(session_key):
    out = []
    for _eid, payload in event_store.since(session_key, None):
        body = payload[5:].strip() if payload.startswith("data:") else ""
        if body == "[DONE]":
            out.append("[DONE]")
            continue
        try:
            out.append(json.loads(body))
        except ValueError:
            pass
    return out


def test_ok_turn_is_bracketed_start_end_done():
    key = "test:frames:ok"

    async def source():
        yield bridge._sse({"delta": "hi"})
        yield chat_turn._DONE_SSE

    asyncio.run(chat_turn.record_turn(key, source(), turn_tasks={}))
    frames = _frames(key)
    assert frames[0]["type"] == "turn_start"
    assert isinstance(frames[0]["turn_id"], int)
    assert frames[0]["session_key"] == key
    assert frames[-2]["type"] == "turn_end"
    assert frames[-2]["status"] == "ok"
    assert frames[-2]["turn_id"] == frames[0]["turn_id"]
    assert frames[-1] == "[DONE]"
    assert turn_state.inflight_for(key) is None


def test_stop_is_labelled_aborted():
    key = "test:frames:aborted"

    async def main():
        gate = asyncio.Event()

        async def source():
            yield bridge._sse({"delta": "working"})
            await gate.wait()  # never set — hangs until cancelled (Stop)

        task = asyncio.create_task(
            chat_turn.record_turn(key, source(), turn_tasks={}))
        await asyncio.sleep(0.05)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task

    asyncio.run(main())
    frames = _frames(key)
    ends = [f for f in frames if isinstance(f, dict) and f.get("type") == "turn_end"]
    assert len(ends) == 1 and ends[0]["status"] == "aborted"
    assert frames[-1] == "[DONE]"
    assert turn_state.inflight_for(key) is None


def test_source_crash_is_labelled_error():
    key = "test:frames:error"

    async def source():
        yield bridge._sse({"delta": "working"})
        raise RuntimeError("gateway blew up")

    with pytest.raises(RuntimeError):
        asyncio.run(chat_turn.record_turn(key, source(), turn_tasks={}))
    frames = _frames(key)
    ends = [f for f in frames if isinstance(f, dict) and f.get("type") == "turn_end"]
    assert len(ends) == 1 and ends[0]["status"] == "error"
    assert frames[-1] == "[DONE]"


def test_exactly_one_turn_end_per_turn():
    # Source emits its own [DONE] (normal path): turn_end must not double up
    # from the finally block.
    key = "test:frames:single-end"

    async def source():
        yield chat_turn._DONE_SSE

    asyncio.run(chat_turn.record_turn(key, source(), turn_tasks={}))
    ends = [f for f in _frames(key)
            if isinstance(f, dict) and f.get("type") == "turn_end"]
    assert len(ends) == 1


def test_ledger_failure_cannot_break_the_turn(monkeypatch):
    key = "test:frames:ledger-start-fails"

    def boom(_key):
        raise OSError("disk full")

    monkeypatch.setattr(chat_turn.turn_state, "turn_started", boom)

    async def source():
        yield bridge._sse({"delta": "hi"})
        yield chat_turn._DONE_SSE

    tasks = {}
    asyncio.run(chat_turn.record_turn(key, source(), turn_tasks=tasks))
    frames = _frames(key)
    assert frames[0]["type"] == "turn_start"
    assert frames[0]["turn_id"] == 0
    assert frames[-1] == "[DONE]"
    assert tasks == {}


def test_ledger_end_failure_still_pops_turn_tasks(monkeypatch):
    key = "test:frames:ledger-end-fails"

    def boom(_key):
        raise OSError("disk full")

    monkeypatch.setattr(chat_turn.turn_state, "turn_ended", boom)

    async def source():
        yield chat_turn._DONE_SSE

    tasks = {}
    asyncio.run(chat_turn.record_turn(key, source(), turn_tasks=tasks))
    assert _frames(key)[-1] == "[DONE]"
    assert tasks == {}
