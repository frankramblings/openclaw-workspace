"""While a turn records, the recorder must emit periodic hb frames so a client
can tell 'no news' from 'dead pipe' (today run_alive fires once and stall only
on trouble). Heartbeats stop with the turn — a finished session's log must not
keep growing."""
import asyncio

from backend import bridge, chat_turn, event_store

from .test_turn_lifecycle_frames import _frames


def test_heartbeats_flow_while_source_is_silent(monkeypatch):
    key = "test:hb:flow"
    monkeypatch.setattr(chat_turn, "_HB_INTERVAL_S", 0.02)

    async def source():
        yield bridge._sse({"delta": "start"})
        await asyncio.sleep(0.1)  # gateway silence — hb must fill the gap
        yield chat_turn._DONE_SSE

    asyncio.run(chat_turn.record_turn(key, source(), turn_tasks={}))
    hbs = [f for f in _frames(key)
           if isinstance(f, dict) and f.get("type") == "hb"]
    assert len(hbs) >= 2
    assert all(isinstance(f.get("elapsed_ms"), int) and f["elapsed_ms"] >= 0
               for f in hbs)
    assert all(isinstance(f.get("turn_id"), int) for f in hbs)


def test_no_heartbeat_after_turn_ends(monkeypatch):
    key = "test:hb:stops"
    monkeypatch.setattr(chat_turn, "_HB_INTERVAL_S", 0.01)

    async def main():
        async def source():
            yield chat_turn._DONE_SSE

        await chat_turn.record_turn(key, source(), turn_tasks={})
        before = len(event_store.since(key, None))
        await asyncio.sleep(0.05)  # several intervals past the end
        return before, len(event_store.since(key, None))

    before, after = asyncio.run(main())
    assert after == before


def test_no_heartbeat_after_source_done_frame(monkeypatch):
    import asyncio
    key = "test:hb:done-window"
    monkeypatch.setattr(chat_turn, "_HB_INTERVAL_S", 0.01)

    async def main():
        async def source():
            yield chat_turn._DONE_SSE
            await asyncio.sleep(0.05)      # source lingers after its own [DONE]

        await chat_turn.record_turn(key, source(), turn_tasks={})
        n = len(event_store.since(key, None))
        await asyncio.sleep(0.05)
        return n, len(event_store.since(key, None))

    before, after = asyncio.run(main())
    assert after == before
    hbs = [1 for _eid, p in event_store.since(key, None) if '"hb"' in p]
    assert not hbs                          # no hb landed after the DONE frame
