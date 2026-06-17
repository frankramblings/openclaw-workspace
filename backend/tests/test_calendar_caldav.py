"""CalDAV client: PROPFIND→calendars, REPORT→events, build PUT body. Network-free
(the _request helper is monkeypatched to return fixture (status, text))."""
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
    import asyncio
    _patch(monkeypatch, 207, REPORT_XML)
    evs = asyncio.run(cd.list_events("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z"))
    assert len(evs) == 1
    assert evs[0]["uid"] == "ev1" and evs[0]["summary"] == "Standup"
    assert evs[0]["calendar"].endswith("/cal/personal/ev1.ics")


def test_time_range_filter_built():
    body = cd._calendar_query_body("20260610T000000Z", "20260611T000000Z")
    assert "time-range" in body and 'start="20260610T000000Z"' in body
