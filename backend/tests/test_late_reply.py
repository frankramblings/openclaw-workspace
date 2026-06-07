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
