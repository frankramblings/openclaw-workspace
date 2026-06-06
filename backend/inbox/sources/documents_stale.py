"""Stale-draft nudges: Documents that are in flight (non-archived, linked to a
chat session) but untouched for DOCS_STALE_DAYS surface in the unified inbox,
so in-flight drafts can't silently die. Item ids embed the updated_at ts: a
dismissed nudge stays dismissed while the doc is untouched, but a doc that is
edited and then goes stale AGAIN gets a fresh id and resurfaces.
Spec: docs/superpowers/specs/2026-06-05-documents-drafting-mode-design.md"""
from __future__ import annotations

import os
import time
from datetime import datetime

from ... import documents, vault_store as vs

STALE_DAYS = float(os.environ.get("DOCS_STALE_DAYS", "4"))


def _iso_ms(iso: str) -> int | None:
    try:
        return int(datetime.fromisoformat(iso).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def map_item(d: dict, now_ms: int) -> dict | None:
    """One library doc -> an inbox item, or None when it isn't a stale draft."""
    if d.get("archived") or not d.get("session_id"):
        return None
    ts = _iso_ms(d.get("updated_at") or "")
    if ts is None:
        return None
    age_h = (now_ms - ts) / 3600_000
    days = int(age_h // 24)
    if days < STALE_DAYS:
        return None
    return {
        "id": f"{d.get('id')}-{ts}", "source": "documents",
        "title": f"Draft sitting {days}d: {d.get('title') or 'Untitled'}",
        "subtitle": d.get("session_name") or "Documents",
        "snippet": (d.get("current_content") or "").strip()[:140],
        "ts": ts, "ageHours": age_h,
        # Older drafts float higher, capped so they never drown fresh inbox items.
        "score": 2 + min(days - int(STALE_DAYS), 6),
        "meta": {"doc_id": d.get("id"), "session_id": d["session_id"],
                 "url": f"/#{d['session_id']}"},
        "actions": ["dismiss", "snooze"],
    }


async def fetch() -> list[dict]:
    """Scan the vault Documents dir. Sync FS work on one folder — fine on the
    event loop (same call pattern as the obsidian collector)."""
    now_ms = int(time.time() * 1000)
    items: list[dict] = []
    if not documents.DOCS_DIR.exists():
        return items
    for p in documents.DOCS_DIR.glob("*.md"):
        try:
            d = vs.load_entry(p, content_key="current_content")
        except Exception:  # noqa: BLE001 - skip unreadable entries
            continue
        item = map_item(d, now_ms)
        if item:
            items.append(item)
    items.sort(key=lambda i: -i["score"])
    return items
