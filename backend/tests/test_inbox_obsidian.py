"""Unit tests for the obsidian meeting-notes collector (pure parts)."""
from backend.inbox.sources import obsidian

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
    assert by_text["send the Q3 deck to legal"] == "action-frank"
    assert by_text["review the launch checklist"] == "action-other"
    assert by_text["ship the new pricing page"] == "action"
    assert by_text["follow up on the analytics bug"] == "unchecked-todo"
    assert by_text["schedule the retro"] == "follow-up"
    assert "random bullet that is not in an action section" not in by_text


def test_short_or_decorative_lines_are_skipped():
    assert obsidian.extract_actions("## Action items\n- ok\n- [[link]]\n") == []


def test_map_items_scores_and_shapes():
    actions = obsidian.extract_actions(NOTE)
    now = 10**12
    file_ts = now - 2 * 3600_000  # 2h old -> recency bonus +2
    items = obsidian.map_items("2026-06-01 Sync.md", "/v/2026-06-01 Sync.md",
                               actions, file_ts, now_ms=now)
    frank = next(i for i in items if i["meta"]["kind"] == "action-frank")
    assert frank["source"] == "obsidian"
    assert frank["score"] == 1 + 4 + 2          # base + action-frank + <24h
    assert frank["subtitle"] == "2026-06-01 Sync"
    assert frank["meta"]["url"].startswith("obsidian://open?path=")
    assert frank["actions"] == ["reviewed", "dismiss", "snooze"]
    # dedup: identical ids are stable hashes
    assert len({i["id"] for i in items}) == len(items)
