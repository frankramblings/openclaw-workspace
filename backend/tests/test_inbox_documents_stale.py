"""Stale-draft collector: in-flight docs untouched for N days become inbox items."""
import asyncio
from datetime import datetime, timedelta, timezone

from backend.inbox.sources import documents_stale


def _iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def test_map_item_stale_doc_becomes_item():
    d = {"id": "doc1", "title": "Q3 plan", "session_id": "s1",
         "session_name": "Q3 chat", "archived": False,
         "updated_at": _iso_days_ago(10), "current_content": "body text"}
    item = documents_stale.map_item(d, _now_ms())
    assert item["source"] == "documents"
    assert item["id"] == f"doc1-{item['ts']}"
    assert "10d" in item["title"] and "Q3 plan" in item["title"]
    assert item["meta"]["url"] == "/#s1"
    assert item["actions"] == ["dismiss", "snooze"]
    assert item["score"] >= 2


def test_map_item_filters():
    now = _now_ms()
    fresh = {"id": "a", "session_id": "s", "archived": False,
             "updated_at": _iso_days_ago(1), "title": "x"}
    archived = {"id": "b", "session_id": "s", "archived": True,
                "updated_at": _iso_days_ago(30), "title": "x"}
    orphan = {"id": "c", "session_id": "", "archived": False,
              "updated_at": _iso_days_ago(30), "title": "x"}
    bad_ts = {"id": "d", "session_id": "s", "archived": False,
              "updated_at": "not-a-date", "title": "x"}
    assert documents_stale.map_item(fresh, now) is None
    assert documents_stale.map_item(archived, now) is None
    assert documents_stale.map_item(orphan, now) is None
    assert documents_stale.map_item(bad_ts, now) is None


def test_fetch_scans_vault(vault_docs):
    vault_docs(id="stale1", updated_at=_iso_days_ago(7))
    vault_docs(id="fresh1", updated_at=_iso_days_ago(1))
    items = asyncio.run(documents_stale.fetch())
    assert [i["meta"]["doc_id"] for i in items] == ["stale1"]
