"""Unit tests for the emoji proxy's pure parts (canon + candidates)."""
from backend.emoji_proxy import canon, candidates


# --- canon: validation + canonicalization ------------------------------------

def test_canon_uppercases_simple_codes():
    assert canon("1f600") == "1F600"
    assert canon("2728") == "2728"


def test_canon_accepts_zwj_sequences():
    assert canon("2764-fe0f-200d-1f525") == "2764-FE0F-200D-1F525"
    assert canon("1f468-200d-1f469-200d-1f466") == "1F468-200D-1F469-200D-1F466"


def test_canon_rejects_garbage_and_traversal():
    assert canon("") is None
    assert canon(None) is None
    assert canon("../../etc/passwd") is None
    assert canon("1f600;rm") is None
    assert canon("zz99") is None
    assert canon("1f600-") is None
    assert canon("-1f600") is None


def test_canon_rejects_oversized_input():
    assert canon("-".join(["1f600"] * 17)) is None   # >16 codepoints


# --- candidates: CDN filename variants ----------------------------------------

def test_plain_code_tries_only_itself():
    assert candidates("1F600") == ["1F600"]


def test_vs16_without_zwj_falls_back_to_stripped():
    # Frontend already strips FE0F here, but cover a raw sequence anyway.
    assert candidates("2764-FE0F") == ["2764-FE0F", "2764"]


def test_zwj_with_vs16_falls_back_to_stripped():
    assert candidates("2764-FE0F-200D-1F525") == [
        "2764-FE0F-200D-1F525", "2764-200D-1F525"]


def test_zwj_without_vs16_tries_inserting_it():
    # OpenMoji names ZWJ sequences WITH the base emoji's FE0F.
    assert candidates("2764-200D-1F525") == [
        "2764-200D-1F525", "2764-FE0F-200D-1F525"]


def test_skin_tone_modifier_passes_through():
    assert candidates("1F44D-1F3FB") == ["1F44D-1F3FB"]
