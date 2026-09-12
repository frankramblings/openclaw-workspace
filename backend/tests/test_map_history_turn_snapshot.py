"""Gateway 2026.9.3 ends a claude-cli turn with an EXTRA assistant message that
carries every text block of the turn joined together. It is a snapshot of what
was already said, not new speech.

`_map_history` used to append it to the last round, so a reload rendered the
whole reply a second time, back to back, inside one response — the doubling
Frank kept reporting. Captured from a real repro turn (thread doubling-repro,
session agent:main:web-261122559771, 2026-09-11), whose /api/history came back as
    content: 'Done. (28, then 29)\\n\\nStep one done.\\n\\nStep two done.\\n\\nDone. (28, then 29)'
while the gateway's own transcript stored the reply exactly once.
"""
from backend.bridge import _map_history


def _repro_messages(joined: str) -> list:
    """The real message run: text, tool, text, tool, text, then the snapshot."""
    return [
        {"role": "user", "content": "do the three steps", "timestamp": 100},
        {"role": "assistant", "timestamp": 101,
         "content": [{"type": "text", "text": "Step one done."}]},
        {"role": "assistant", "timestamp": 102, "content": [
            {"type": "toolCall", "id": "t1", "name": "Bash",
             "arguments": {"command": "date +%S"}}]},
        {"role": "toolResult", "toolCallId": "t1", "content": "28"},
        {"role": "assistant", "timestamp": 103,
         "content": [{"type": "text", "text": "Step two done."}]},
        {"role": "assistant", "timestamp": 104, "content": [
            {"type": "toolCall", "id": "t2", "name": "Bash",
             "arguments": {"command": "date +%S"}}]},
        {"role": "toolResult", "toolCallId": "t2", "content": "29"},
        {"role": "assistant", "timestamp": 105,
         "content": [{"type": "text", "text": "Done. (28, then 29)"}]},
        # The per-TURN snapshot the gateway appends.
        {"role": "assistant", "timestamp": 106,
         "content": [{"type": "text", "text": joined}]},
    ]


def test_trailing_turn_snapshot_does_not_double_the_reply():
    joined = "Step one done.\n\nStep two done.\n\nDone. (28, then 29)"
    turn = _map_history(_repro_messages(joined))["history"][1]

    rounds = turn["metadata"]["round_texts"]
    assert rounds == ["Step one done.", "Step two done.", "Done. (28, then 29)"], rounds
    # The canonical content is the LAST thing said, once.
    assert turn["content"] == "Done. (28, then 29)"
    # Nothing the user already read may appear twice anywhere in the turn.
    whole = "\n\n".join(rounds)
    for line in ("Step one done.", "Step two done.", "Done. (28, then 29)"):
        assert whole.count(line) == 1, f"{line!r} rendered {whole.count(line)}x: {whole!r}"


def test_snapshot_is_dropped_even_when_the_join_whitespace_differs():
    # Don't hard-code the gateway's separator: a single-newline join is the same
    # re-delivery and must not slip through as new speech.
    joined = "Step one done.\nStep two done.\nDone. (28, then 29)"
    turn = _map_history(_repro_messages(joined))["history"][1]
    assert turn["metadata"]["round_texts"] == [
        "Step one done.", "Step two done.", "Done. (28, then 29)"]
    assert turn["content"] == "Done. (28, then 29)"


def test_genuine_repeat_of_the_last_line_is_still_kept():
    # Guard against over-matching: a trailing message that merely repeats the
    # LAST block is not a whole-turn snapshot, so it stays.
    msgs = _repro_messages("Done. (28, then 29)")
    turn = _map_history(msgs)["history"][1]
    assert turn["metadata"]["round_texts"][-1] == (
        "Done. (28, then 29)\n\nDone. (28, then 29)")


def test_pure_text_turn_drops_the_snapshot_too():
    # A tool-free turn emits one history entry per assistant message, so an
    # unfiltered snapshot would render as a whole second reply bubble.
    msgs = [
        {"role": "user", "content": "two thoughts please", "timestamp": 100},
        {"role": "assistant", "timestamp": 101,
         "content": [{"type": "text", "text": "First thought."}]},
        {"role": "assistant", "timestamp": 102,
         "content": [{"type": "text", "text": "Second thought."}]},
        {"role": "assistant", "timestamp": 103,
         "content": [{"type": "text", "text": "First thought.\n\nSecond thought."}]},
    ]
    texts = [m["content"] for m in _map_history(msgs)["history"]
             if m["role"] == "assistant"]
    assert texts == ["First thought.", "Second thought."], texts


def test_snapshot_spanning_earlier_turns_is_dropped():
    """Captured real case, thread d4a3a72f1857 (2026-09-11 ~20:00).

    The gateway's closing message was NOT a whole-turn snapshot. It held
    narration blocks from three EARLIER user turns followed by this turn's
    answer, so it equalled nothing said this turn and the equality guard let it
    through. `_map_history` appended it to the round and the answer rendered
    twice with the session's narration wedged between the copies (content went
    2830 -> 6101 chars). The tell is that it ENDS with the answer already shown.
    """
    answer = ("**Next action: don't install any of them.** " + "x" * 200)
    msgs = [
        {"role": "user", "content": "is this a good fit?", "timestamp": 100},
        {"role": "assistant", "timestamp": 101,
         "content": [{"type": "text", "text": "Checking what thread this follows from."}]},
        {"role": "user", "content": "what if we roll our own", "timestamp": 102},
        {"role": "assistant", "timestamp": 103,
         "content": [{"type": "text", "text": "Dropping the roll-your-own thread for now."}]},
        {"role": "user", "content": "look for other projects", "timestamp": 104},
        {"role": "assistant", "timestamp": 105, "content": [
            {"type": "toolCall", "id": "t1", "name": "WebSearch",
             "arguments": {"query": "openclaw memory plugins"}}]},
        {"role": "toolResult", "toolCallId": "t1", "content": "results"},
        {"role": "assistant", "timestamp": 106,
         "content": [{"type": "text", "text": "Narrowing to the OpenClaw-native ones."}]},
        {"role": "assistant", "timestamp": 107,
         "content": [{"type": "text", "text": answer}]},
        # The closing snapshot: earlier turns' narration, then the answer again.
        {"role": "assistant", "timestamp": 108, "content": [{"type": "text", "text": (
            "Checking what thread this follows from.\n\n"
            "Dropping the roll-your-own thread for now.\n\n"
            "Narrowing to the OpenClaw-native ones.\n\n" + answer)}]},
    ]
    turn = _map_history(msgs)["history"][-1]
    # The defect was the answer appearing twice with narration between the copies.
    assert turn["content"].count("**Next action") == 1, turn["content"][:200]
    assert turn["content"].endswith(answer)
    # And the narration must not be re-listed inside the answer's round.
    assert turn["content"].count("Checking what thread this follows from.") == 0
