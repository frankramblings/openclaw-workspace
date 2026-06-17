"""CalDAV provider (RFC 4791) over httpx. Returns the SAME canonical calendar /
event dicts as the Google provider. Auth is HTTP Basic (username + app-password).
The user gives a calendar *home* collection URL; we PROPFIND Depth:1 to list the
calendars under it, and calendar-query REPORT each for events in a time range.
Network-free in tests: `_request` is the single HTTP seam to monkeypatch."""
from __future__ import annotations

import urllib.parse
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


async def list_events(time_min: str, time_max: str) -> list[dict]:
    """REPORT against the calendar home (Depth:1 covers all calendars under it).
    Many CalDAV servers (iCloud, Fastmail, Nextcloud, Google) support a
    calendar-query REPORT on the home collection with Depth:1, which is simpler
    than PROPFIND + per-calendar REPORT and makes the network seam testable with
    a single monkeypatched fixture."""
    base = calendar_config.caldav_settings()["url"]
    if not base:
        return []
    start, end = _ical_compact(time_min), _ical_compact(time_max)
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
        for e in ical.parse_events(data or ""):
            e["color"] = _DEFAULT_COLOR
            e["event_type"] = "default"
            e["calendar"] = _abs(ev_href)  # event href = its CalDAV resource URL
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
    cal = payload.get("calendar") or calendar_config.caldav_settings()["url"]
    ev = {**payload, "uid": uid}
    url = _event_url(cal, uid)
    status, _ = await _request("PUT", url, body=ical.build_vcalendar(ev),
                               content_type="text/calendar")
    if status >= 300:
        raise RuntimeError(f"CalDAV PUT failed ({status})")
    return {**ev, "color": payload.get("color") or _DEFAULT_COLOR,
            "event_type": "default", "calendar": url,
            "all_day": bool(payload.get("all_day"))}


async def update_event(uid: str, payload: dict) -> dict:
    # The frontend sends the event's CalDAV href back as `calendar`; PUT to it.
    url = payload.get("calendar") or _event_url(
        calendar_config.caldav_settings()["url"], uid)
    ev = {**payload, "uid": uid}
    status, _ = await _request("PUT", url, body=ical.build_vcalendar(ev),
                               content_type="text/calendar")
    if status >= 300:
        raise RuntimeError(f"CalDAV PUT failed ({status})")
    return {**ev, "color": payload.get("color") or _DEFAULT_COLOR,
            "event_type": "default", "calendar": url,
            "all_day": bool(payload.get("all_day"))}


async def delete_event(uid: str, calendar: str) -> dict:
    url = calendar or _event_url(calendar_config.caldav_settings()["url"], uid)
    status, _ = await _request("DELETE", url)
    if status not in (200, 204, 404):
        raise RuntimeError(f"CalDAV DELETE failed ({status})")
    return {"ok": True, "deleted": [uid]}
