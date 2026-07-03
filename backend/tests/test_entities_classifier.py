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
