"""CalDAV provider (RFC 4791) over httpx. Returns the SAME canonical calendar /
event dicts as the Google provider. Auth is HTTP Basic (username + app-password).
The user gives a calendar *home* collection URL; we PROPFIND Depth:1 to list the
calendars under it, and calendar-query REPORT each for events in a time range.
Network-free in tests: `_request` is the single HTTP seam to monkeypatch."""
from __future__ import annotations

import urllib.parse
from datetime import datetime, timezone
from xml.etree import ElementTree as ET

import httpx

from . import calendar_config, ical

_DEFAULT_COLOR = "#6ea8fe"
_NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav",
       "ic": "http://apple.com/ns/ical/"}


async def _request(method: str, url: str, *, body=None, depth=None, content_type=None):
    """One CalDAV HTTP request → (status_code, text). The only network seam."""
    s = calendar_config.caldav_settings()
    headers = {}
    if depth is not None:
        headers["Depth"] = str(depth)
    if content_type:
        headers["Content-Type"] = content_type
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        r = await client.request(method, url, content=body, headers=headers,
                                 auth=(s["username"], s["password"]))
    return r.status_code, r.text


def _abs(href: str) -> str:
    """Resolve a server-relative href against the configured base URL's origin."""
    base = calendar_config.caldav_settings()["url"]
    return urllib.parse.urljoin(base, href)


def _parse_calendars(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for resp in root.findall("d:response", _NS):
        rtype = resp.find(".//d:resourcetype", _NS)
        is_cal = rtype is not None and rtype.find("c:calendar", _NS) is not None
        if not is_cal:
            continue
        href = (resp.findtext("d:href", default="", namespaces=_NS) or "").strip()
        name = resp.findtext(".//d:displayname", default="", namespaces=_NS) or href
        color = (resp.findtext(".//ic:calendar-color", default="", namespaces=_NS)
                 or _DEFAULT_COLOR)[:7] or _DEFAULT_COLOR
        out.append({"href": _abs(href), "name": name.strip(), "color": color,
                    "hex": color, "primary": False})
    return out


def _calendar_query_body(start: str, end: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8" ?>'
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
        '<c:filter><c:comp-filter name="VCALENDAR">'
        '<c:comp-filter name="VEVENT">'
        f'<c:time-range start="{start}" end="{end}"/>'
        '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')


def _ical_compact(iso: str) -> str:
    return iso.replace("-", "").replace(":", "")


def _ical_range(iso: str, *, is_end: bool = False) -> str:  # noqa: ARG001
    """Convert a frontend ISO string to an RFC 4791 UTC date-time string.

    RFC 4791 §9.9 requires YYYYMMDDTHHMMSSZ for time-range start/end.
    The frontend always passes YYYY-MM-DD (bare date) or a full ISO datetime.
    - bare date → YYYYMMDDT000000Z
    - datetime with Z or offset → normalize to UTC → YYYYMMDDTHHMMSSZ
    - naive datetime (no tz) → assume UTC → YYYYMMDDTHHMMSSZ
    """
    iso = (iso or "").strip()
    if not iso:
        return iso
    # Bare date: len==10 and no "T"
    if len(iso) == 10 and "T" not in iso:
        compact = iso.replace("-", "")
        return f"{compact}T000000Z"
    # Has time component — normalize to UTC
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    except ValueError:
        # Fallback: best-effort compact strip
        return _ical_compact(iso)


async def list_calendars() -> list[dict]:
    base = calendar_config.caldav_settings()["url"]
    if not base:
        return []
    status, text = await _request(
        "PROPFIND", base, depth=1, content_type="application/xml",
        body=('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
              'xmlns:c="urn:ietf:params:xml:ns:caldav" '
              'xmlns:ic="http://apple.com/ns/ical/"><d:prop>'
              '<d:displayname/><d:resourcetype/><ic:calendar-color/>'
              '</d:prop></d:propfind>'))
    if status >= 300:
        return []
    return _parse_calendars(text)


def _collection_href(resource_href: str) -> str:
    """Given an event resource href (e.g. /cal/personal/ev1.ics), return the
    parent collection href (e.g. https://dav.example/cal/personal/)."""
    abs_href = _abs(resource_href)
    # Strip the last path segment (the filename) to get the collection
    parsed = urllib.parse.urlparse(abs_href)
    parent_path = parsed.path.rsplit("/", 1)[0] + "/"
    return urllib.parse.urlunparse(parsed._replace(path=parent_path))


async def list_events(time_min: str, time_max: str) -> list[dict]:
    """REPORT against the calendar home (Depth:1 covers all calendars under it).
    Many CalDAV servers (iCloud, Fastmail, Nextcloud, Google) support a
    calendar-query REPORT on the home collection with Depth:1, which is simpler
    than PROPFIND + per-calendar REPORT and makes the network seam testable with
    a single monkeypatched fixture."""
    base = calendar_config.caldav_settings()["url"]
    if not base:
        return []
    # Bug 1 fix: use RFC 4791-compliant UTC date-time strings
    start, end = _ical_range(time_min), _ical_range(time_max)
    status, text = await _request(
        "REPORT", base, depth=1, content_type="application/xml",
        body=_calendar_query_body(start, end))
    if status >= 300:
        return []
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    out: list[dict] = []
    for resp in root.findall("d:response", _NS):
        ev_href = (resp.findtext("d:href", default="", namespaces=_NS) or "").strip()
        data = resp.findtext(".//c:calendar-data", default="", namespaces=_NS)
        resource_url = _abs(ev_href)
        # Bug 3 fix: set calendar_href = COLLECTION href (parent of resource href)
        cal_href = _collection_href(ev_href)
        for e in ical.parse_events(data or ""):
            e["color"] = _DEFAULT_COLOR
            e["event_type"] = "default"
            e["calendar"] = resource_url  # event resource URL (backward compat)
            e["calendar_href"] = cal_href  # COLLECTION href for grouping/color
            out.append(e)
    return out


def _event_url(payload_calendar: str, uid: str) -> str:
    """Event resource URL = <calendar collection>/<uid>.ics. payload_calendar is
    the calendar href the frontend round-trips from list_events/list_calendars."""
    coll = payload_calendar.rstrip("/") + "/"
    return urllib.parse.urljoin(coll, f"{urllib.parse.quote(uid)}.ics")


async def create_event(payload: dict) -> dict:
    import uuid
    uid = payload.get("uid") or uuid.uuid4().hex
    # Bug 3 fix: prefer calendar_href (collection), then calendar, then base
    base = calendar_config.caldav_settings()["url"]
    collection = (payload.get("calendar_href") or payload.get("calendar") or base)
    ev = {**payload, "uid": uid}
    url = _event_url(collection, uid)
    status, _ = await _request("PUT", url, body=ical.build_vcalendar(ev),
                               content_type="text/calendar")
    if status >= 300:
        raise RuntimeError(f"CalDAV PUT failed ({status})")
    return {**ev, "color": payload.get("color") or _DEFAULT_COLOR,
            "event_type": "default",
            "calendar": url,             # resource URL
            "calendar_href": collection,  # collection URL
            "all_day": bool(payload.get("all_day"))}


async def update_event(uid: str, payload: dict) -> dict:
    # Bug 3 fix: use calendar_href (collection) to reconstruct resource URL;
    # fall back to base for drag-resize (which sends no calendar_href).
    base = calendar_config.caldav_settings()["url"]
    collection = payload.get("calendar_href") or base
    url = _event_url(collection, uid)
    ev = {**payload, "uid": uid}
    status, _ = await _request("PUT", url, body=ical.build_vcalendar(ev),
                               content_type="text/calendar")
    if status >= 300:
        raise RuntimeError(f"CalDAV PUT failed ({status})")
    return {**ev, "color": payload.get("color") or _DEFAULT_COLOR,
            "event_type": "default",
            "calendar": url,             # resource URL
            "calendar_href": collection,  # collection URL
            "all_day": bool(payload.get("all_day"))}


async def delete_event(uid: str, calendar: str | None) -> dict:
    """Delete an event by uid. calendar may be:
    - None / empty / "primary" → reconstruct from base URL
    - a resource href ending in .ics → use directly
    - a collection href (http/https URL) → append <uid>.ics
    Never passes a non-URL string to httpx.
    """
    base = calendar_config.caldav_settings()["url"]
    if not calendar or calendar == "primary":
        # Bug 2 fix: default path → reconstruct from base
        url = _event_url(base, uid)
    elif calendar.endswith(".ics"):
        # Already a resource href
        url = calendar if "://" in calendar else _abs(calendar)
    elif calendar.startswith(("http://", "https://")):
        # Collection href → append uid.ics
        url = _event_url(calendar, uid)
    else:
        # Unknown form → reconstruct from base (safe fallback)
        url = _event_url(base, uid)
    status, _ = await _request("DELETE", url)
    if status not in (200, 204, 404):
        raise RuntimeError(f"CalDAV DELETE failed ({status})")
    return {"ok": True, "deleted": [uid]}
