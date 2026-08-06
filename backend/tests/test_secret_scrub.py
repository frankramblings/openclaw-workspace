"""Tests for backend.secret_scrub — focus on the gmail-app-password pattern
that used to false-positive on ordinary prose (four 4-letter words in a row)."""
from secret_scrub import scrub


def test_prose_four_short_words_not_flagged():
    # The real regression: "does that work over" is four 4-letter lowercase
    # words in a row and used to be redacted as a gmail app password.
    msg = ("What documents do I need to prove I lived at those addresses? "
           "And how does that work over the phone anyway")
    out, found = scrub(msg)
    assert found == [], f"false positive: {found}"
    assert out == msg


def test_other_prose_four_short_word_runs_not_flagged():
    for msg in ("what does this mean", "come back next week okay",
                "have some time here", "will they meet here soon"):
        out, found = scrub(msg)
        assert "gmail-app-password" not in found, f"false positive on: {msg!r}"


def test_contiguous_16_lowercase_is_flagged():
    out, found = scrub("my app password is abcdefghijklmnop thanks")
    assert "gmail-app-password" in found
    assert "abcdefghijklmnop" not in out
    assert "[REDACTED:gmail-app-password]" in out


def test_spaced_4x4_form_deliberately_not_flagged():
    # Structurally identical to a four-word sentence, so we intentionally do NOT
    # match the spaced display form — only the contiguous-16 paste form.
    out, found = scrub("here it is:\nabcd efgh ijkl mnop\nuse that")
    assert "gmail-app-password" not in found


def test_empty_and_clean_text():
    assert scrub("") == ("", [])
    assert scrub("just a normal sentence with no secrets") == (
        "just a normal sentence with no secrets", [])
