"""CalDAV client: PROPFIND→calendars, REPORT→events, build PUT body. Network-free
(the _request helper is monkeypatched to return fixture (status, text))."""
import asyncio

import pytest

from backend import calendar_caldav as cd

PROPFIND_XML = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
               xmlns:ic="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/cal/personal/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Personal</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <ic:calendar-color>#FF0000</ic:calendar-color>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Home</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"""

REPORT_XML = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/personal/ev1.ics</d:href>
    <d:propstat><d:prop>
      <c:calendar-data>BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:ev1\r
SUMMARY:Standup\r
DTSTART:20260610T150000Z\r
DTEND:20260610T151500Z\r
END:VEVENT\r
END:VCALENDAR\r
</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"""


def _patch(monkeypatch, status, text):
    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        return status, text
    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})


def test_parse_calendars_filters_non_calendar_collections(monkeypatch):
    import asyncio
    _patch(monkeypatch, 207, PROPFIND_XML)
    cals = asyncio.run(cd.list_calendars())
    assert len(cals) == 1                      # only the c:calendar one
    assert cals[0]["name"] == "Personal"
    assert cals[0]["href"].endswith("/cal/personal/")
    assert cals[0]["hex"] == "#FF0000"


def test_parse_events_via_report(monkeypatch):
    _patch(monkeypatch, 207, REPORT_XML)
    evs = asyncio.run(cd.list_events("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z"))
    assert len(evs) == 1
    assert evs[0]["uid"] == "ev1" and evs[0]["summary"] == "Standup"
    assert evs[0]["calendar"].endswith("/cal/personal/ev1.ics")
    # Bug 3: calendar_href must be the COLLECTION, not the resource
    assert evs[0]["calendar_href"].endswith("/cal/personal/")


def test_time_range_filter_built():
    body = cd._calendar_query_body("20260610T000000Z", "20260611T000000Z")
    assert "time-range" in body and 'start="20260610T000000Z"' in body


# =============================================================================
# Bug 1 — _ical_range: RFC 4791 UTC datetime conversion
# =============================================================================

def test_ical_range_bare_date():
    """Bare date YYYY-MM-DD → YYYYMMDDT000000Z (RFC 4791 §9.9 required)."""
    assert cd._ical_range("2026-06-01") == "20260601T000000Z"


def test_ical_range_bare_date_end():
    assert cd._ical_range("2026-06-30", is_end=True) == "20260630T000000Z"


def test_ical_range_utc_datetime_passthrough():
    """UTC datetime already has Z — should come back as compact UTC."""
    result = cd._ical_range("2026-06-10T00:00:00Z")
    assert result == "20260610T000000Z"


def test_ical_range_offset_datetime_normalizes_to_utc():
    """An offset datetime (e.g. -04:00) must be shifted to UTC."""
    # 2026-06-10T20:00:00-04:00 == 2026-06-11T00:00:00Z
    result = cd._ical_range("2026-06-10T20:00:00-04:00")
    assert result == "20260611T000000Z"


def test_ical_range_naive_datetime_treated_as_utc():
    """A naive datetime (no tz info) → treated as UTC."""
    result = cd._ical_range("2026-06-10T15:30:00")
    assert result == "20260610T153000Z"


def test_list_events_request_body_uses_rfc4791_datetime(monkeypatch):
    """list_events must send YYYYMMDDT000000Z in the time-range, not bare dates."""
    captured = {}

    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        captured["body"] = body or ""
        return 207, "<d:multistatus xmlns:d='DAV:'/>"

    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})
    asyncio.run(cd.list_events("2026-06-01", "2026-06-30"))
    body = captured.get("body", "")
    # Must contain T000000Z, not bare compact dates like 20260601
    assert "T000000Z" in body, f"Expected T000000Z in body, got: {body!r}"
    assert '20260601T000000Z' in body
    assert '20260630T000000Z' in body


# =============================================================================
# Bug 2 — delete_event: never pass a non-URL to httpx
# =============================================================================

def _patch_delete(monkeypatch):
    """Returns a list that captures (method, url) of each _request call."""
    calls = []

    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        calls.append((method, url))
        return 204, ""

    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})
    return calls


def test_delete_event_none_calendar_uses_base(monkeypatch):
    """delete_event(uid, None) → DELETE <base>/<uid>.ics, never 'primary'."""
    calls = _patch_delete(monkeypatch)
    result = asyncio.run(cd.delete_event("u1", None))
    assert result == {"ok": True, "deleted": ["u1"]}
    assert len(calls) == 1
    method, url = calls[0]
    assert method == "DELETE"
    assert url == "https://dav.example/cal/u1.ics", f"Got: {url!r}"


def test_delete_event_primary_string_uses_base(monkeypatch):
    """delete_event(uid, 'primary') must NOT request URL 'primary'."""
    calls = _patch_delete(monkeypatch)
    asyncio.run(cd.delete_event("u2", "primary"))
    _, url = calls[0]
    assert url.startswith("https://"), f"Non-URL passed to _request: {url!r}"
    assert url.endswith("u2.ics")


def test_delete_event_collection_href_appends_uid_ics(monkeypatch):
    """A collection href (http URL without .ics) → <coll>/<uid>.ics."""
    calls = _patch_delete(monkeypatch)
    asyncio.run(cd.delete_event("u3", "https://dav.example/cal/personal/"))
    _, url = calls[0]
    assert url == "https://dav.example/cal/personal/u3.ics"


def test_delete_event_resource_href_used_verbatim(monkeypatch):
    """A .ics resource href is used verbatim (absolute or resolved)."""
    calls = _patch_delete(monkeypatch)
    asyncio.run(cd.delete_event("u4", "https://dav.example/cal/personal/u4.ics"))
    _, url = calls[0]
    assert url == "https://dav.example/cal/personal/u4.ics"


def test_delete_event_404_is_ok(monkeypatch):
    """404 response is treated as success (already gone)."""
    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        return 404, ""
    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})
    result = asyncio.run(cd.delete_event("u5", None))
    assert result["ok"] is True


def test_delete_event_server_error_raises(monkeypatch):
    """Non-200/204/404 status raises RuntimeError."""
    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        return 500, "Server Error"
    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})
    with pytest.raises(RuntimeError, match="DELETE failed"):
        asyncio.run(cd.delete_event("u6", None))


# =============================================================================
# Bug 3 — create_event respects calendar_href + returns calendar_href
# =============================================================================

def _patch_create(monkeypatch):
    """Patches _request to accept PUT and return 201."""
    calls = []

    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        calls.append((method, url, body or ""))
        return 201, ""

    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})
    return calls


def test_create_event_uses_calendar_href(monkeypatch):
    """create_event with calendar_href PUTs under that collection."""
    calls = _patch_create(monkeypatch)
    result = asyncio.run(cd.create_event({
        "summary": "Meeting", "dtstart": "2026-06-10T14:00:00Z",
        "dtend": "2026-06-10T15:00:00Z", "all_day": False,
        "calendar_href": "https://dav.example/cal/work/",
    }))
    assert len(calls) == 1
    method, url, _ = calls[0]
    assert method == "PUT"
    assert url.startswith("https://dav.example/cal/work/")
    assert url.endswith(".ics")
    # Returned dict must carry calendar_href = the collection
    assert result["calendar_href"] == "https://dav.example/cal/work/"
    assert result["calendar"].startswith("https://dav.example/cal/work/")


def test_create_event_without_calendar_href_uses_base(monkeypatch):
    """create_event without calendar_href PUTs under the base URL."""
    calls = _patch_create(monkeypatch)
    result = asyncio.run(cd.create_event({
        "summary": "Standup", "dtstart": "2026-06-11T09:00:00Z",
        "dtend": "2026-06-11T09:15:00Z", "all_day": False,
    }))
    _, url, _ = calls[0]
    assert url.startswith("https://dav.example/cal/")
    assert result["calendar_href"] == "https://dav.example/cal/"


def test_create_event_calendar_field_fallback(monkeypatch):
    """create_event with legacy 'calendar' field (no calendar_href) still works."""
    calls = _patch_create(monkeypatch)
    result = asyncio.run(cd.create_event({
        "summary": "Fallback", "dtstart": "2026-06-12T10:00:00Z",
        "dtend": "2026-06-12T10:30:00Z", "all_day": False,
        "calendar": "https://dav.example/cal/personal/",
    }))
    _, url, _ = calls[0]
    assert url.startswith("https://dav.example/cal/personal/")
    assert result["calendar_href"] == "https://dav.example/cal/personal/"


# =============================================================================
# Bug 3 — list_events sets calendar_href to COLLECTION (parent of resource href)
# =============================================================================

def test_list_events_sets_calendar_href(monkeypatch):
    """list_events must set calendar_href = the collection (parent dir)."""
    _patch(monkeypatch, 207, REPORT_XML)
    evs = asyncio.run(cd.list_events("2026-06-10", "2026-06-11"))
    assert len(evs) == 1
    ev = evs[0]
    # calendar_href = collection = parent of /cal/personal/ev1.ics
    assert "calendar_href" in ev
    # It should end with /personal/ (the collection), not /ev1.ics
    assert ev["calendar_href"].endswith("/cal/personal/")
    assert not ev["calendar_href"].endswith(".ics")
    # calendar (resource URL) still present for backward compat
    assert ev["calendar"].endswith("/cal/personal/ev1.ics")
