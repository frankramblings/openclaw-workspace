"""The Odysseus Calendar tab, backed by the real Google Calendar API.

Reuses the google-calendar-mcp OAuth token (via google_auth) and talks the
Calendar REST API directly with httpx — no Node MCP middleman. Maps Google ⇄ the
iCal-ish shape calendar.js renders: dates are strings (YYYY-MM-DD for all-day,
ISO datetime for timed). quick-parse routes to the OpenClaw brain.

This module exposes the 5 provider functions (list_calendars, list_events,
create_event, update_event, delete_event) as plain async functions returning
canonical dicts. The router lives in calendar.py which imports these.
"""
from __future__ import annotations

import asyncio
import json as _json
import re
import urllib.parse

import httpx

from . import bridge, config, google_auth

_API = "https://www.googleapis.com/calendar/v3"
_DEFAULT_COLOR = "#4285f4"


# --- low-level Google API helpers --------------------------------------------

def _auth() -> dict:
    return {"Authorization": f"Bearer {google_auth.access_token()}"}


def _cal_path(cal_id: str) -> str:
    return urllib.parse.quote(cal_id or "primary", safe="")


# One shared client: each request used to pay a fresh TCP+TLS handshake, and
# the events view fans out to every visible calendar (~8 calls per view).
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        # Bound the keep-alive pool and expire idle connections quickly so
        # Google-closed keep-alives don't pile up in CLOSE_WAIT and leak fds.
        _client = httpx.AsyncClient(
            timeout=30,
            limits=httpx.Limits(max_keepalive_connections=5, keepalive_expiry=30),
        )
    return _client


async def _headers() -> dict:
    # access_token() does a sync httpx POST on refresh — keep it off the loop.
    return await asyncio.to_thread(_auth)


async def _get(path: str, params: dict | None = None) -> dict:
    r = await _http().get(f"{_API}{path}", headers=await _headers(),
                          params=params or {})
    r.raise_for_status()
    return r.json()


async def _post(path: str, body: dict) -> dict:
    r = await _http().post(f"{_API}{path}", json=body, headers=await _headers())
    r.raise_for_status()
    return r.json()


# --- pure mappers (unit-tested) ----------------------------------------------

def map_calendar(c: dict) -> dict:
    bg = c.get("backgroundColor") or _DEFAULT_COLOR
    return {"href": c.get("id"), "name": c.get("summary") or c.get("id"),
            "color": bg, "hex": bg, "primary": bool(c.get("primary"))}


def map_event(e: dict, cal_id: str, color: str) -> dict:
    start, end = e.get("start") or {}, e.get("end") or {}
    return {
        "uid": e.get("id"),
        "summary": e.get("summary") or "(no title)",
        "dtstart": start.get("date") or start.get("dateTime") or "",
        "dtend": end.get("date") or end.get("dateTime") or "",
        "all_day": "date" in start,
        "location": e.get("location") or "",
        "description": e.get("description") or "",
        "color": color,
        "event_type": "default",
        "calendar": cal_id,
    }


def to_google_event(d: dict) -> dict:
    g = {"summary": d.get("summary") or "",
         "location": d.get("location") or "",
         "description": d.get("description") or ""}
    if d.get("all_day"):
        g["start"] = {"date": d.get("dtstart")}
        g["end"] = {"date": d.get("dtend") or d.get("dtstart")}
    else:
        g["start"] = {"dateTime": d.get("dtstart")}
        g["end"] = {"dateTime": d.get("dtend") or d.get("dtstart")}
    return g


def _to_rfc3339(day: str, is_end: bool) -> str:
    """Frontend sends YYYY-MM-DD; widen to a full-day RFC3339 instant."""
    day = (day or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return f"{day}T23:59:59Z" if is_end else f"{day}T00:00:00Z"
    return day  # already ISO / empty → pass through


# --- provider functions (5 canonical ops) ------------------------------------

async def list_calendars() -> list[dict]:
    data = await _get("/users/me/calendarList")
    return [map_calendar(c) for c in data.get("items", [])]


async def _events_for(cal_id: str, color: str, time_min: str, time_max: str) -> list[dict]:
    try:
        data = await _get(f"/calendars/{_cal_path(cal_id)}/events",
                          {"timeMin": time_min, "timeMax": time_max,
                           "singleEvents": "true", "orderBy": "startTime",
                           "maxResults": 2500})
    except Exception:  # noqa: BLE001
        return []
    return [map_event(e, cal_id, color) for e in data.get("items", [])]


async def list_events(time_min: str, time_max: str) -> list[dict]:
    tmin, tmax = _to_rfc3339(time_min, False), _to_rfc3339(time_max, True)
    cal_data = await _get("/users/me/calendarList")
    cals = [(c["id"], c.get("backgroundColor") or _DEFAULT_COLOR)
            for c in cal_data.get("items", []) if not c.get("hidden")]
    results = await asyncio.gather(*[_events_for(cid, color, tmin, tmax)
                                     for cid, color in cals])
    return [e for sub in results for e in sub]


async def create_event(payload: dict) -> dict:
    cal = payload.get("calendar") or "primary"
    g = await _post(f"/calendars/{_cal_path(cal)}/events", to_google_event(payload))
    return map_event(g, cal, payload.get("color") or _DEFAULT_COLOR)


async def update_event(uid: str, payload: dict) -> dict:
    cal = payload.get("calendar") or "primary"
    url = f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.patch(url, json=to_google_event(payload), headers=await _headers())
    r.raise_for_status()
    return map_event(r.json(), cal, payload.get("color") or _DEFAULT_COLOR)


async def delete_event(uid: str, calendar: str) -> dict:
    cal = calendar or "primary"
    url = f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.delete(url, headers=await _headers())
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text[:300])
    return {"ok": True, "deleted": [uid]}


# --- brain helper (used by calendar.py quick-parse) --------------------------

async def _brain_once(prompt: str) -> str:
    chunks: list[str] = []
    async for sse in bridge.stream_turn(prompt, session_key=config.web_session_key()):
        if not sse.startswith("data:"):
            continue
        line = sse[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            o = _json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(o, dict) and o.get("delta"):
            chunks.append(o["delta"])
    return "".join(chunks).strip()


# --- ICS import helper -------------------------------------------------------

def _ics_iso(v: str) -> str:
    v = v.strip()
    if len(v) == 8:                       # 20260704 -> 2026-07-04
        return f"{v[:4]}-{v[4:6]}-{v[6:8]}"
    if "T" in v:                          # 20260704T130000Z -> ISO
        return f"{v[:4]}-{v[4:6]}-{v[6:8]}T{v[9:11]}:{v[11:13]}:{v[13:15]}Z"
    return v


# --- Calendar invites + RSVP (unified inbox) ---------------------------------
# Gmail auto-adds incoming invites to the primary calendar with the user's own
# attendee entry at responseStatus=needsAction. We surface those as inbox items
# and let Yes/Maybe/No write the response straight back via the API (the
# organizer is notified with sendUpdates=all). No email/.ics parsing needed.

INVITE_WINDOW_DAYS = 60

# Map the UI's friendly verbs (and Google's own) → Google responseStatus values.
RESPONSE_MAP = {
    "yes": "accepted", "accepted": "accepted",
    "maybe": "tentative", "tentative": "tentative",
    "no": "declined", "declined": "declined",
    "needsaction": "needsAction", "needsAction": "needsAction",
}


def self_attendee(event: dict) -> dict | None:
    """The user's own entry in an event's attendee list (Google flags it with
    self=true), or None when the event has no such attendee (e.g. a personal
    event the user created with no guests)."""
    for a in (event or {}).get("attendees") or []:
        if a.get("self"):
            return a
    return None


def is_pending_invite(event: dict) -> bool:
    """True when this is an invite the user still owes a response to: cancelled
    events are skipped, and the user's own attendee entry must be needsAction."""
    if (event or {}).get("status") == "cancelled":
        return False
    me = self_attendee(event)
    return bool(me) and me.get("responseStatus") == "needsAction"


def apply_rsvp(event: dict, response: str) -> dict:
    """Pure: build the PATCH body that sets the user's responseStatus, leaving
    every other attendee untouched. Raises ValueError on a bad response or when
    the user isn't an attendee (nothing to RSVP)."""
    status = RESPONSE_MAP.get(str(response or "").strip())
    if not status:
        raise ValueError(f"invalid RSVP response: {response!r}")
    attendees = [dict(a) for a in (event or {}).get("attendees") or []]
    mine = next((a for a in attendees if a.get("self")), None)
    if mine is None:
        raise ValueError("you are not an attendee of this event")
    mine["responseStatus"] = status
    return {"attendees": attendees}


async def _patch(path: str, body: dict, params: dict | None = None) -> dict:
    r = await _http().patch(f"{_API}{path}", json=body, headers=await _headers(),
                            params=params or {})
    r.raise_for_status()
    return r.json()


async def list_pending_invites(time_min: str, time_max: str) -> list[dict]:
    """Raw Google events on the primary calendar that the user hasn't yet
    answered, soonest first. Returns the Google event resources (the inbox
    source maps them); empty on any API error so the collector fails soft."""
    try:
        data = await _get(
            f"/calendars/{_cal_path('primary')}/events",
            {"timeMin": time_min, "timeMax": time_max, "singleEvents": "true",
             "orderBy": "startTime", "maxResults": 250, "showDeleted": "false"})
    except Exception:  # noqa: BLE001 — per-source isolation upstream
        return []
    return [e for e in data.get("items", []) if is_pending_invite(e)]


async def rsvp(event_id: str, calendar: str, response: str) -> dict:
    """Respond to an invite: read the event, flip the user's responseStatus,
    PATCH it back with sendUpdates=all so the organizer is notified."""
    cal = _cal_path(calendar or "primary")
    eid = urllib.parse.quote(event_id, safe="")
    event = await _get(f"/calendars/{cal}/events/{eid}")
    body = apply_rsvp(event, response)        # raises on bad input
    return await _patch(f"/calendars/{cal}/events/{eid}", body,
                        params={"sendUpdates": "all"})
