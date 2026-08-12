"""Tests for backend.secret_scrub.

The gmail-app-password pattern was removed because a 16 random-lowercase-letter
credential is regex-indistinguishable from an ordinary 16-letter word, so it
false-positived on everyday prose. These tests lock in that ordinary text (short
words in a row, long lowercase words, contiguous 16-letter runs) is NEVER flagged,
while structurally-distinct tokens still are."""
from secret_scrub import scrub


def test_prose_four_short_words_not_flagged():
    msg = ("What documents do I need to prove I lived at those addresses? "
           "And how does that work over the phone anyway")
    out, found = scrub(msg)
    assert found == [], f"false positive: {found}"
    assert out == msg


def test_other_prose_four_short_word_runs_not_flagged():
    for msg in ("what does this mean", "come back next week okay",
                "have some time here", "will they meet here soon"):
        out, found = scrub(msg)
        assert found == [], f"false positive on: {msg!r}"


def test_sixteen_letter_word_not_flagged():
    # No gmail pattern anymore: 16-letter lowercase words / runs stay untouched.
    for msg in ("this is a misunderstanding", "abcdefghijklmnop",
                "my responsibilities keep growing"):
        out, found = scrub(msg)
        assert found == [], f"false positive on: {msg!r}"
        assert out == msg


def test_structural_tokens_still_flagged():
    out, found = scrub("here is the key sk-abcdefghijklmnopqrstuvwx1234 ok")
    assert "api-key" in found
    assert "[REDACTED:api-key]" in out


def test_empty_and_clean_text():
    assert scrub("") == ("", [])
    assert scrub("just a normal sentence with no secrets") == (
        "just a normal sentence with no secrets", [])
