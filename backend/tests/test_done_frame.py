"""_is_done_frame must match ONLY the terminal `data: [DONE]` marker, never a
delta whose text merely contains the literal "[DONE]" — otherwise a real reply
(or a message about this very SSE code) gets dropped mid-stream / cuts the tail."""
from backend.app import _is_done_frame


def test_exact_marker_is_done():
    assert _is_done_frame("data: [DONE]\n\n") is True
    assert _is_done_frame("data: [DONE]") is True


def test_delta_containing_done_is_not_terminal():
    # The model emitting the literal token in its answer must NOT end the turn.
    assert _is_done_frame('data: {"delta": "the stream ends with [DONE]"}\n\n') is False
    assert _is_done_frame('data: {"delta": "[DONE]"}\n\n') is False


def test_other_frames_are_not_done():
    assert _is_done_frame('data: {"type": "metrics", "data": {}}\n\n') is False
    assert _is_done_frame(": keepalive\n\n") is False
    assert _is_done_frame("") is False
