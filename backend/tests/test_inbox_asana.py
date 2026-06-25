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


# --- task detail reader (B3) ---------------------------------------------

def test_map_task_detail_extracts_fields_and_comments():
    task = {
        "name": "Edit the spotlight video", "notes": "Trim the intro.",
        "due_on": "2026-06-12", "due_at": None, "completed": False,
        "assignee": {"name": "Frank Emanuele"},
        "permalink_url": "https://app.asana.com/0/x/99",
    }
    stories = [
        {"type": "comment", "text": "first pass done",
         "created_at": asana._iso_from_ms(NOW - 2 * 3600_000),
         "created_by": {"name": "Taylor"}},
        {"type": "system", "text": "changed the due date",
         "created_at": asana._iso_from_ms(NOW - 3600_000),
         "created_by": {"name": "Asana"}},
        {"type": "comment", "text": "looks good",
         "created_at": asana._iso_from_ms(NOW - 1800_000),
         "created_by": {"name": "Frank"}},
    ]
    d = asana.map_task_detail(task, stories)
    assert d["name"] == "Edit the spotlight video"
    assert d["notes"] == "Trim the intro."
    assert d["assignee"] == "Frank Emanuele"
    assert d["url"] == "https://app.asana.com/0/x/99"
    # system stories dropped; only comments, oldest-first
    assert [c["text"] for c in d["comments"]] == ["first pass done", "looks good"]
    assert d["comments"][0]["author"] == "Taylor"


def test_map_task_detail_handles_missing_bits():
    d = asana.map_task_detail({}, [])
    assert d["name"] == "(no name)"
    assert d["comments"] == []
    assert d["assignee"] is None


import pytest

@pytest.mark.asyncio
async def test_create_task_posts_to_project(monkeypatch):
    calls = {}
    async def fake_api(method, path, body=None):
        calls["method"], calls["path"], calls["body"] = method, path, body
        return {"data": {"gid": "999"}}
    monkeypatch.setattr(asana, "_api", fake_api)
    monkeypatch.setattr(asana._inbox_settings, "asana_project_gid", lambda: "PROJ")
    gid = await asana.create_task("Follow up with Taylor", "from meeting note", "2026-07-01", "SEC")
    assert gid == "999"
    assert calls["method"] == "POST"
    assert calls["path"] == "/tasks"
    data = calls["body"]["data"]
    assert data["name"] == "Follow up with Taylor"
    assert data["notes"] == "from meeting note"
    assert data["due_on"] == "2026-07-01"
    # placed in the Backlog section of the project
    assert {"project": "PROJ", "section": "SEC"} in data["memberships"]

@pytest.mark.asyncio
async def test_create_task_without_due_or_section(monkeypatch):
    captured = {}
    async def fake_api(method, path, body=None):
        captured["body"] = body
        return {"data": {"gid": "1"}}
    monkeypatch.setattr(asana, "_api", fake_api)
    monkeypatch.setattr(asana._inbox_settings, "asana_project_gid", lambda: "PROJ")
    await asana.create_task("x", "y", None, None)
    data = captured["body"]["data"]
    assert "due_on" not in data
    assert data["projects"] == ["PROJ"]

@pytest.mark.asyncio
async def test_delete_task(monkeypatch):
    calls = {}
    async def fake_api(method, path, body=None):
        calls["method"], calls["path"] = method, path
        return {"data": {}}
    monkeypatch.setattr(asana, "_api", fake_api)
    await asana.delete_task("42")
    assert calls["method"] == "DELETE"
    assert calls["path"] == "/tasks/42"
