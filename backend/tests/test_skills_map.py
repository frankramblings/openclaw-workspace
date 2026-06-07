"""Unit tests for the skills mapper."""
from backend.skills import _map_skill


def test_map_skill_exposes_enabled():
    assert _map_skill({"name": "a"})["enabled"] is True
    assert _map_skill({"name": "a", "disabled": True})["enabled"] is False
