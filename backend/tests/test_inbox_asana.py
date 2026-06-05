"""Unit tests for the asana collector's pure mapper."""
from backend.inbox.sources import asana

NOW = 10**12
DAY = 24 * 3600_000


def _task(gid="11", name="Ship it", section="In Progress", due_ms=None,
          completed=False):
    return {
        "gid": gid, "name": name, "completed": completed,
        "memberships": [{"section": {"name": section, "gid": "s1"}}],
        "due_at": asana._iso_from_ms(due_ms) if due_ms else None,
        "due_on": None,
        "modified_at": asana._iso_from_ms(NOW - 3600_000),
        "permalink_url": "https://app.asana.com/0/x/11",
        "notes": "some notes",
    }


def test_overdue_in_progress_scores_highest():
    items = asana.map_items([_task(due_ms=NOW - DAY)], now_ms=NOW)
    assert items[0]["score"] == 4 + 4      # In Progress + overdue
    assert items[0]["subtitle"] == "In Progress"
    assert items[0]["actions"] == ["complete", "dismiss", "snooze"]
    assert items[0]["meta"]["url"] == "https://app.asana.com/0/x/11"


def test_backlog_no_due_scores_base():
    items = asana.map_items([_task(section="Backlog")], now_ms=NOW)
    assert items[0]["score"] == 2


def test_completed_and_inactive_sections_skipped():
    assert asana.map_items([_task(completed=True)], now_ms=NOW) == []
    assert asana.map_items([_task(section="Completed")], now_ms=NOW) == []


def test_due_soon_tiers():
    soon = asana.map_items([_task(due_ms=NOW + int(0.5 * DAY))], now_ms=NOW)
    week = asana.map_items([_task(due_ms=NOW + 5 * DAY)], now_ms=NOW)
    assert soon[0]["score"] == 4 + 3       # <1 day
    assert week[0]["score"] == 4 + 1       # <7 days
