"""Unit tests for strip_context_block — the display-side inverse of context_block."""
from backend.websearch import context_block, strip_context_block

RESULTS = [
    {"title": "A", "url": "https://a.example", "snippet": "first"},
    {"title": "B", "url": "https://b.example", "snippet": "second"},
]


def test_round_trips_back_to_the_user_message():
    assert strip_context_block(context_block("reply with an emoji", RESULTS)) \
        == "reply with an emoji"


def test_plain_user_text_passes_through():
    assert strip_context_block("just a normal message") == "just a normal message"


def test_text_containing_marker_but_not_prefix_passes_through():
    tricky = "notes\n\n---\n\nUser message: not actually a search block"
    assert strip_context_block(tricky) == tricky


def test_query_containing_the_marker_survives_partition():
    # partition() takes everything after the FIRST marker, so a marker-shaped
    # string inside the user's own text stays intact.
    weird = "echo this:\n\n---\n\nUser message: nested"
    assert strip_context_block(context_block(weird, RESULTS)) == weird


def test_non_strings_pass_through():
    assert strip_context_block(None) is None
    assert strip_context_block([{"type": "text"}]) == [{"type": "text"}]
