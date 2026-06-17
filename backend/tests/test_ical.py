"""Pure iCalendar VEVENT parse + VCALENDAR build (no I/O, no network)."""
from backend import ical

SAMPLE = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
    "UID:abc-123\r\nSUMMARY:Lunch with Sam\r\n"
    "DTSTART:20260610T180000Z\r\nDTEND:20260610T190000Z\r\n"
    "LOCATION:Cafe\r\nDESCRIPTION:catch up\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")

ALLDAY = (
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d1\r\nSUMMARY:Holiday\r\n"
    "DTSTART;VALUE=DATE:20260612\r\nDTEND;VALUE=DATE:20260613\r\n"
    "END:VEVENT\r\nEND:VCALENDAR\r\n")


def test_parse_timed_event():
    evs = ical.parse_events(SAMPLE)
    assert len(evs) == 1
    e = evs[0]
    assert e["uid"] == "abc-123"
    assert e["summary"] == "Lunch with Sam"
    assert e["dtstart"] == "2026-06-10T18:00:00Z"
    assert e["dtend"] == "2026-06-10T19:00:00Z"
    assert e["all_day"] is False
    assert e["location"] == "Cafe" and e["description"] == "catch up"


def test_parse_all_day_event():
    e = ical.parse_events(ALLDAY)[0]
    assert e["all_day"] is True
    assert e["dtstart"] == "2026-06-12" and e["dtend"] == "2026-06-13"


def test_parse_unfolds_long_lines():
    folded = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f1\r\n"
              "SUMMARY:Hello \r\n World\r\nDTSTART:20260610T180000Z\r\n"
              "END:VEVENT\r\nEND:VCALENDAR\r\n")  # RFC5545 line folding: CRLF + space
    assert ical.parse_events(folded)[0]["summary"] == "Hello World"


def test_parse_unescapes_text():
    raw = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\n"
           "SUMMARY:A\\, B\\; C\\nD\r\nDTSTART:20260610T180000Z\r\n"
           "END:VEVENT\r\nEND:VCALENDAR\r\n")
    assert ical.parse_events(raw)[0]["summary"] == "A, B; C\nD"


def test_build_timed_roundtrips():
    out = ical.build_vcalendar({
        "uid": "x1", "summary": "Plan, review; ship", "dtstart": "2026-06-10T18:00:00Z",
        "dtend": "2026-06-10T19:00:00Z", "all_day": False, "location": "HQ",
        "description": "line1\nline2"})
    assert "BEGIN:VEVENT" in out and "UID:x1" in out
    assert "DTSTART:20260610T180000Z" in out
    assert "SUMMARY:Plan\\, review\\; ship" in out      # escaped
    assert "DESCRIPTION:line1\\nline2" in out
    back = ical.parse_events(out)[0]
    assert back["summary"] == "Plan, review; ship" and back["dtstart"] == "2026-06-10T18:00:00Z"


def test_build_all_day():
    out = ical.build_vcalendar({"uid": "a1", "summary": "Off", "dtstart": "2026-06-12",
                                "dtend": "2026-06-13", "all_day": True})
    assert "DTSTART;VALUE=DATE:20260612" in out
    assert "DTEND;VALUE=DATE:20260613" in out


def test_build_vcalendar_offset_datetime_normalized_to_utc():
    """A dtstart with a numeric TZ offset (what quick-parse emits) must become a
    valid UTC instant, not a mangled '...0400' string."""
    from backend import ical
    vcal = ical.build_vcalendar({
        "uid": "x@example.com", "summary": "Sync",
        "dtstart": "2026-06-10T18:00:00-04:00",
        "dtend": "2026-06-10T18:30:00-04:00",
    })
    assert "DTSTART:20260610T220000Z" in vcal   # 18:00 -04:00 == 22:00 UTC
    assert "DTEND:20260610T223000Z" in vcal
    assert "0400" not in vcal                    # no mangled offset


def test_build_vcalendar_utc_and_naive_and_allday():
    from backend import ical
    z = ical.build_vcalendar({"uid": "a", "summary": "s",
                              "dtstart": "2026-06-10T18:00:00Z",
                              "dtend": "2026-06-10T19:00:00Z"})
    assert "DTSTART:20260610T180000Z" in z
    naive = ical.build_vcalendar({"uid": "a", "summary": "s",
                                  "dtstart": "2026-06-10T18:00:00",
                                  "dtend": "2026-06-10T19:00:00"})
    assert "DTSTART:20260610T180000" in naive and "DTSTART:20260610T180000Z" not in naive
    allday = ical.build_vcalendar({"uid": "a", "summary": "s", "all_day": True,
                                   "dtstart": "2026-06-10", "dtend": "2026-06-11"})
    assert "DTSTART;VALUE=DATE:20260610" in allday
