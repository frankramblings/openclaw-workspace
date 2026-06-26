"""Unit tests for the obsidian meeting-notes collector (pure parts)."""
import pytest

from backend.inbox import settings as inbox_settings
from backend.inbox.sources import obsidian


@pytest.fixture(autouse=True)
def _owner(monkeypatch):
    """The fixtures assign actions to "Frank"; configure that as the owner so
    they score as "mine" (the owner name is configurable, not hardcoded)."""
    monkeypatch.setattr(inbox_settings, "obsidian_owner_name", lambda: "Frank")


NOTE = """# 2026-06-01 Sync with Taylor

Some discussion text.

## Action items
- Frank: send the Q3 deck to legal
- Taylor - review the launch checklist
- ship the new pricing page

## Notes
- [ ] follow up on the analytics bug
- random bullet that is not in an action section
Follow-up: schedule the retro
"""


def test_extracts_actions_with_kinds():
    actions = obsidian.extract_actions(NOTE)
    by_text = {a["text"]: a["kind"] for a in actions}
    assert by_text["send the Q3 deck to legal"] == "action-mine"
    assert by_text["review the launch checklist"] == "action-other"
    assert by_text["ship the new pricing page"] == "action"
    assert by_text["follow up on the analytics bug"] == "unchecked-todo"
    assert by_text["schedule the retro"] == "follow-up"
    assert "random bullet that is not in an action section" not in by_text


def test_short_or_decorative_lines_are_skipped():
    assert obsidian.extract_actions("## Action items\n- ok\n- [[link]]\n") == []


def test_checkbox_inside_action_section_is_unchecked_todo():
    note = "## Action items\n- [ ] fix the analytics bug\n"
    actions = obsidian.extract_actions(note)
    assert actions == [
        {"kind": "unchecked-todo", "text": "fix the analytics bug", "line": 2}]


def test_map_items_scores_and_shapes():
    actions = obsidian.extract_actions(NOTE)
    now = 10**12
    file_ts = now - 2 * 3600_000  # 2h old -> recency bonus +2
    items = obsidian.map_items("2026-06-01 Sync.md", "/v/2026-06-01 Sync.md",
                               actions, file_ts, now_ms=now)
    mine = next(i for i in items if i["meta"]["kind"] == "action-mine")
    assert mine["source"] == "obsidian"
    assert mine["score"] == 1 + 4 + 2          # base + action-mine + <24h
    assert mine["subtitle"] == "2026-06-01 Sync"
    assert mine["meta"]["url"].startswith("obsidian://open?path=")
    assert mine["actions"] == ["add_asana", "reviewed", "dismiss", "snooze"]
    # dedup: identical ids are stable hashes
    assert len({i["id"] for i in items}) == len(items)


def test_owner_name_unset_means_no_mine_boost(monkeypatch):
    """With no owner configured, a personally-assigned action is just
    'action-other' (the owner name is not hardcoded to any maintainer)."""
    monkeypatch.setattr(inbox_settings, "obsidian_owner_name", lambda: "")
    by_text = {a["text"]: a["kind"] for a in obsidian.extract_actions(NOTE)}
    assert by_text["send the Q3 deck to legal"] == "action-other"
