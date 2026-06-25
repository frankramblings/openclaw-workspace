"""Calendar invites you still owe a response to, via the Google Calendar API.

Gmail auto-adds incoming invites to the primary calendar at
responseStatus=needsAction; we surface those as inbox items whose Yes/Maybe/No
buttons (frontend) POST action=rsvp and write the response straight back
through calendar_google.rsvp(). No email/.ics parsing — the calendar is the
source of truth, which also de-dupes the noisy Gmail "Invitation:" emails
(suppressed in the gmail collector).
"""
from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from ... import calendar_google
from .. import settings as _inbox_settings  # noqa: F401 — symmetry w/ other sources


def _parse_start(event: dict) -> tuple[int | None, bool]:
    """Return (epoch_ms, all_day) for an event's start, or (None, _) if unknown."""
    start = event.get("start") or {}
    if start.get("dateTime"):
        try:
            dt = datetime.fromisoformat(start["dateTime"].replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000), False
        except ValueError:
            return None, False
    if start.get("date"):
        try:
            dt = datetime.fromisoformat(start["date"]).replace(tzinfo=timezone.utc)
            return int(dt.timestamp() * 1000), True
        except ValueError:
            return None, True
    return None, False


def _when_label(start_ms: int | None, all_day: bool) -> str:
    if start_ms is None:
        return ""
    dt = datetime.fromtimestamp(start_ms / 1000, tz=timezone.utc)
    if all_day:
        return dt.strftime("%a %b %-d")
    return dt.strftime("%a %b %-d, %-I:%M %p")


def map_items(events: list[dict], now_ms: int) -> list[dict]:
    items = []
    for e in events:
        start_ms, all_day = _parse_start(e)
        org = e.get("organizer") or {}
        organizer = org.get("displayName") or org.get("email") or "Organizer"
        when = _when_label(start_ms, all_day)
        # Soon = both higher score and smaller ageHours (sorts to the top).
        score = 5
        hours_until = (start_ms - now_ms) / 3600_000 if start_ms is not None else 1e6
        if hours_until < 24:
            score += 3
        elif hours_until < 72:
            score += 2
        elif hours_until < 168:
            score += 1
        body_bits = [b for b in (organizer, when, e.get("location") or "") if b]
        items.append({
            "id": str(e.get("id") or ""),
            "source": "calendar",
            "title": e.get("summary") or "(untitled invite)",
            "subtitle": organizer,
            "snippet": " · ".join(body_bits),
            "ts": start_ms or now_ms,
            "ageHours": max(0.0, hours_until),
            "score": score,
            "meta": {
                "url": e.get("htmlLink"),
                "event_id": str(e.get("id") or ""),
                "calendar": "primary",
                "start": (e.get("start") or {}).get("dateTime")
                or (e.get("start") or {}).get("date"),
                "organizer": org.get("email"),
                "isInvite": True,
            },
            "actions": ["rsvp", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


async def fetch() -> list[dict]:
    now = datetime.now(timezone.utc)
    time_min = now.isoformat()
    time_max = (now + timedelta(days=calendar_google.INVITE_WINDOW_DAYS)).isoformat()
    events = await calendar_google.list_pending_invites(time_min, time_max)
    return map_items(events, now_ms=int(time.time() * 1000))
