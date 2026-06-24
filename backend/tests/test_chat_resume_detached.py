"""Regression: a turn must keep running + recording server-side after the
browser that started it goes away (refresh / thread-switch / tab close).

Frank's bug: leaving a chat thread mid-answer lost the in-flight turn — no
progress while away, no end result on return. Root cause: the gateway relay +
event-log recorder lived INSIDE the browser's StreamingResponse generator, so a
client disconnect tore down the recorder and prematurely flipped the turn
inactive even though the gateway agent kept working.

The fix detaches the recorder from any single reader: `_start_turn_recorder`
launches a background task that drains the turn's frames into `event_store`
regardless of who (if anyone) is consuming the POST response. The POST handler
then just tails `event_store`, so a dropped reader can never stop the turn.

These tests pin that contract.
"""
import anyio
import pytest

from backend import app as app_module
from backend import bridge, config, event_store


@pytest.fixture(autouse=True)
def _fake_extract(monkeypatch):
    async def _noop(session_key):
        return None
    monkeypatch.setattr(app_module, "maybe_auto_extract", _noop)


def _payloads(session_key):
    return "".join(payload for _eid, payload in event_store.since(session_key, None))


def test_recorder_survives_reader_disconnect():
    """The reader tails the first event, then leaves (its task is cancelled).
    The recorder must keep going: the event produced AFTER the reader left is
    still recorded, and the turn settles to inactive when the source ends."""
    key = "test:detached:reader-leaves"

    async def main():
        gate = anyio.Event()

        async def source():
            yield bridge._sse({"delta": "before-leave"})
            await gate.wait()                      # gateway still working post-disconnect
            yield bridge._sse({"delta": "after-leave"})
            yield bridge._sse("[DONE]")

        # Detached writer — independent of any reader.
        task = app_module._start_turn_recorder(key, source)

        # A reader tails the live log until it sees the first event, then leaves.
        async def reader():
            q = event_store.subscribe(key)
            try:
                while True:
                    _eid, payload = await q.get()
                    if "before-leave" in payload:
                        return
            finally:
                event_store.unsubscribe(key, q)

        with anyio.fail_after(5):
            await reader()

        # Reader is gone. Release the post-disconnect event; recorder must catch it.
        gate.set()
        with anyio.fail_after(5):
            await task

        text = _payloads(key)
        assert "before-leave" in text
        assert "after-leave" in text, \
            "event produced AFTER the reader left must still be recorded"
        assert event_store.current_turn(key)["active"] is False

    anyio.run(main)


def test_chat_stream_post_disconnect_keeps_recording(monkeypatch):
    """HTTP contract: POST /api/chat_stream must drive the gateway relay through
    the DETACHED recorder, not inside its own response generator. So when the
    POST reader disconnects mid-turn (uvicorn cancels the response), the turn
    keeps recording: a gateway frame produced AFTER the reader leaves is still
    landed in event_store, and the turn settles inactive.

    This is the end-to-end version of test_recorder_survives_reader_disconnect,
    pinned at the real endpoint."""
    key = "test:chatstream:disconnect"
    # session="" resolves to web_session_key(); pin it to an isolated test key.
    monkeypatch.setattr(config, "web_session_key", lambda: key)
    # Don't touch the turn-timing log file from a unit test.
    monkeypatch.setattr(app_module, "_log_turn_timing", lambda *a, **k: None)

    async def main():
        gate = anyio.Event()

        async def fake_stream_turn(message, session_key=None, run_info=None, **kw):
            yield bridge._sse({"delta": "before-disconnect"})
            await gate.wait()                      # gateway still working post-disconnect
            yield bridge._sse({"delta": "after-disconnect"})

        monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)

        resp = await app_module.chat_stream(
            message="hi", session="", use_web="", allow_web_search="",
            attachments="", active_doc_id="")

        # A reader consumes the POST tail until the first frame, then disconnects
        # (its task is cancelled — exactly what uvicorn does on client drop).
        seen_first = anyio.Event()

        async def reader():
            async for chunk in resp.body_iterator:
                s = chunk if isinstance(chunk, str) else chunk.decode()
                if "before-disconnect" in s:
                    seen_first.set()

        async with anyio.create_task_group() as tg:
            tg.start_soon(reader)
            with anyio.fail_after(5):
                await seen_first.wait()
            tg.cancel_scope.cancel()               # reader leaves mid-turn

        # The recorder must own the turn independently of that reader.
        task = app_module._TURN_TASKS.get(key)
        assert task is not None, \
            "chat_stream must start a detached recorder that outlives the reader"

        gate.set()                                 # release the post-disconnect frame
        with anyio.fail_after(5):
            await task

        text = _payloads(key)
        assert "before-disconnect" in text
        assert "after-disconnect" in text, \
            "frame produced after the POST reader left must still be recorded"
        assert event_store.current_turn(key)["active"] is False

    anyio.run(main)


def test_turn_active_then_inactive_across_recorder_lifetime():
    """current_turn flips active at begin and inactive at end — this is what the
    reload path (`/api/chat/turn`) reads to decide whether to resume."""
    key = "test:detached:active-flag"

    async def main():
        gate = anyio.Event()

        async def source():
            yield bridge._sse({"delta": "x"})
            await gate.wait()
            yield bridge._sse("[DONE]")

        task = app_module._start_turn_recorder(key, source)

        # Give the recorder a tick to begin the turn.
        with anyio.fail_after(5):
            for _ in range(200):
                if event_store.current_turn(key)["active"]:
                    break
                await anyio.sleep(0.01)
        assert event_store.current_turn(key)["active"] is True

        gate.set()
        with anyio.fail_after(5):
            await task
        assert event_store.current_turn(key)["active"] is False

    anyio.run(main)
