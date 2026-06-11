"""Unit tests for the late-delivery fallback's pure parts (_sse_frame, reply_after)."""
from backend.app import _sse_frame, reply_after


# --- _sse_frame ----------------------------------------------------------------

def test_parses_delta_frames():
    assert _sse_frame('data: {"delta": "hi"}\n\n') == {"delta": "hi"}


def test_done_and_garbage_are_none():
    assert _sse_frame("data: [DONE]\n\n") is None
    assert _sse_frame("data: not json\n\n") is None
    assert _sse_frame("") is None
    assert _sse_frame('data: ["a", "list"]\n\n') is None


# --- reply_after ----------------------------------------------------------------

HIST = [
    {"role": "user", "content": "first question"},
    {"role": "assistant", "content": "first answer"},
    {"role": "user", "content": "second question"},
    {"role": "assistant", "content": "second answer"},
]


def test_returns_only_this_turns_reply():
    assert reply_after(HIST, "second question") == "second answer"


def test_never_returns_an_earlier_turns_reply():
    # The turn's message is in the transcript but nothing follows it yet —
    # must NOT fall back to "first answer".
    pending = HIST[:3]
    assert reply_after(pending, "second question") is None


def test_matches_the_last_occurrence_of_a_repeated_message():
    hist = HIST + [{"role": "user", "content": "first question"},
                   {"role": "assistant", "content": "asked again"}]
    assert reply_after(hist, "first question") == "asked again"


def test_unknown_message_returns_none():
    assert reply_after(HIST, "never sent") is None


def test_joins_multiple_assistant_messages():
    hist = [{"role": "user", "content": "q"},
            {"role": "assistant", "content": "part one"},
            {"role": "assistant", "content": "part two"}]
    assert reply_after(hist, "q") == "part one\npart two"


# --- _late_reply backoff schedule -------------------------------------------------

import asyncio

from backend import app as app_module


def test_late_reply_first_check_is_fast(monkeypatch):
    """The reply already exists when this poll starts — a flat 2s first sleep
    was pure added latency on every message-tool turn."""
    delays = []

    async def fake_sleep(s):
        delays.append(s)

    async def fake_fetch_history(session_key):
        return {"history": [
            {"role": "user", "content": "msg"},
            {"role": "assistant", "content": "the reply"},
        ]}

    monkeypatch.setattr(app_module.bridge, "fetch_history", fake_fetch_history)
    out = asyncio.run(app_module._late_reply("k", "msg", _sleep=fake_sleep))
    assert out == "the reply"
    assert delays == [0.3]


def test_late_reply_walks_full_backoff_then_gives_up(monkeypatch):
    delays = []

    async def fake_sleep(s):
        delays.append(s)

    async def fake_fetch_history(session_key):
        return {"history": []}

    monkeypatch.setattr(app_module.bridge, "fetch_history", fake_fetch_history)
    out = asyncio.run(app_module._late_reply("k", "msg", _sleep=fake_sleep))
    assert out is None
    assert delays == list(app_module._LATE_REPLY_SCHEDULE)
    assert abs(sum(delays) - 10.0) < 0.01   # same ~10s ceiling as before
