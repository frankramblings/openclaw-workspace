"""Gmail inbox items via himalaya (same CLI + account as the Email tab).

Keeps unread and flagged INBOX envelopes; scoring ports the old triage
heuristics: unread+3, important(Flagged)+2, <6h+2 / <24h+1, external sender+1.
meta.url is intentionally absent — himalaya envelopes carry no Message-ID, so
the UI lazily resolves the Gmail deep link via /api/email/read/{uid}
(mark_seen=false) on Open."""
from __future__ import annotations

import os
import time
from datetime import datetime, timezone

from ... import himalaya_cli
from .. import settings as _inbox_settings

# INTERNAL_DOMAIN is now resolved via inbox.settings at call time (env still wins).
INTERNAL_DOMAIN = os.environ.get("INBOX_INTERNAL_DOMAIN", "example.com")
LIST_SIZE = int(os.environ.get("INBOX_GMAIL_LIST", "50"))


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat()


def _ts_ms(date_str: str) -> int:
    try:
        return int(datetime.fromisoformat(date_str).timestamp() * 1000)
    except (ValueError, TypeError):
        return int(time.time() * 1000)


def map_items(envelopes: list[dict], now_ms: int) -> list[dict]:
    items = []
    for env in envelopes:
        flags = env.get("flags") or []
        unread = "Seen" not in flags
        important = "Flagged" in flags
        if not unread and not important:
            continue
        # Calendar REQUEST invites surface as their own RSVP-able inbox items
        # (the calendar collector), so drop the duplicate Gmail notification.
        if _inbox_settings.calendar_enabled():
            _subj = (env.get("subject") or "").lstrip().lower()
            if _subj.startswith("invitation:") or _subj.startswith("updated invitation:"):
                continue
        frm = env.get("from") or {}
        addr = frm.get("addr") or frm.get("address") or ""
        name = frm.get("name") or addr
        ts = _ts_ms(env.get("date") or "")
        age_h = max(0.0, (now_ms - ts) / 3600_000)
        score = 0
        if unread:
            score += 3
        if important:
            score += 2
        if age_h < 6:
            score += 2
        elif age_h < 24:
            score += 1
        if addr and not addr.lower().endswith(f"@{_inbox_settings.gmail_internal_domain()}"):
            score += 1
        items.append({
            "id": str(env.get("id", "")), "source": "gmail",
            "title": env.get("subject") or "(no subject)",
            "subtitle": name, "snippet": "",
            "ts": ts, "ageHours": age_h, "score": score,
            "meta": {"uid": str(env.get("id", "")), "from": addr,
                     "unread": unread, "important": important},
            "actions": ["archive", "delete", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


async def fetch() -> list[dict]:
    data = await himalaya_cli.run_json(
        ["envelope", "list", "-f", "INBOX", "-s", str(LIST_SIZE)])
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    return map_items(envs, now_ms=int(time.time() * 1000))
