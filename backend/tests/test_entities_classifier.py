import pytest

from backend.inbox.sources.entities import guess_type


@pytest.mark.parametrize("name,expected", [
    ("Automation Suite", "project"),
    ("Creator Program", "project"),
    ("Impact Report", "event"),
    ("All Hands Meeting", "event"),
    ("Weekly Sync", "event"),
    ("Q3 Recap", "event"),
    ("Wistia Labs", "org"),
    ("Acme Inc", "org"),
    ("Brand Team", "org"),
    ("Allie Joel", "person"),
    ("Ash Ladouceur", "person"),
    ("Jayde Powell", "person"),
])
def test_guess_type(name, expected):
    assert guess_type(name) == expected


def test_guess_type_ambiguous_defaults_other():
    # Single token, or no signal and not name-shaped → other, never person.
    assert guess_type("Blueprint") == "other"
    assert guess_type("Social Videos") in {"person", "other"}


@pytest.mark.parametrize("name", [
    "Social Videos",   # common-noun phrase, not a name
    "Promote School",  # verb phrase, not a name
    "Mon Jul",         # date fragment
    "Thu Dec",         # date fragment
])
def test_guess_type_never_defaults_bare_phrase_to_person(name):
    # The module contract is "person only if it looks like an actual First Last
    # name" — a bare two-word phrase with no given-name signal must NOT be person.
    assert guess_type(name) == "other"


@pytest.mark.parametrize("name", [
    "Erica Griffith",  # real person in Frank's feed
    "Elise Beck",
])
def test_guess_type_known_given_name_is_person(name):
    assert guess_type(name) == "person"
