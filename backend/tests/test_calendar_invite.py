"""Unit tests for the pure .ics invite parser (calendar_invite.parse_ics_calendar)."""
from backend.calendar_invite import parse_ics_calendar

REQUEST = (
    "BEGIN:VCALENDAR\r\n"
    "METHOD:REQUEST\r\n"
    "VERSION:2.0\r\n"
    "BEGIN:VEVENT\r\n"
    "DTSTART;TZID=America/New_York:20260610T130000\r\n"
    "DTEND;TZID=America/New_York:20260610T133000\r\n"
    "DTSTAMP:20260608T120000Z\r\n"
    "ORGANIZER;CN=Alex Doe:mailto:adoe@example.com\r\n"
    "ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;CN=You:"
    "mailto:you@example.com\r\n"
    "ATTENDEE;CN=Alex Doe;PARTSTAT=ACCEPTED:mailto:adoe@example.com\r\n"
    "SUMMARY:Webflow Social Announcement - Brainstorm\r\n"
    " /chat\r\n"                                   # folded continuation line
    "LOCATION:Google Meet\r\n"
    "DESCRIPTION:Line one\\nLine two\\, still going\r\n"
    "STATUS:CONFIRMED\r\n"
    "END:VEVENT\r\n"
    "END:VCALENDAR\r\n"
)


def test_request_core_fields():
    cal = parse_ics_calendar(REQUEST)
    assert cal["method"] == "REQUEST"
    assert cal["summary"] == "Webflow Social Announcement - Brainstorm/chat"  # unfolded
    assert cal["location"] == "Google Meet"
    assert cal["status"] == "CONFIRMED"


def test_description_is_unescaped():
    cal = parse_ics_calendar(REQUEST)
    assert cal["description"] == "Line one\nLine two, still going"


def test_organizer_and_attendees():
    cal = parse_ics_calendar(REQUEST)
    assert cal["organizer"] == {"name": "Alex Doe",
                                "email": "adoe@example.com"}
    assert len(cal["attendees"]) == 2
    me = cal["attendees"][0]
    assert me["email"] == "you@example.com"
    assert me["name"] == "You"
    assert me["partstat"] == "NEEDS-ACTION"


def test_tzid_datetime_resolves_to_offset_iso():
    cal = parse_ics_calendar(REQUEST)
    s = cal["start"]
    assert s["all_day"] is False
    assert s["tzid"] == "America/New_York"
    # June in NY = EDT (-04:00)
    assert s["iso"] == "2026-06-10T13:00:00-04:00"


def test_all_day_value_date():
    ics = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n"
           "DTSTART;VALUE=DATE:20260610\r\nDTEND;VALUE=DATE:20260611\r\n"
           "SUMMARY:Company Holiday\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")
    cal = parse_ics_calendar(ics)
    assert cal["start"]["all_day"] is True
    assert cal["start"]["iso"] == "2026-06-10"


def test_utc_zulu_datetime():
    ics = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\n"
           "DTSTART:20260610T170000Z\r\nSUMMARY:Sync\r\n"
           "END:VEVENT\r\nEND:VCALENDAR\r\n")
    cal = parse_ics_calendar(ics)
    assert cal["start"]["iso"] == "2026-06-10T17:00:00+00:00"


def test_no_vevent_returns_none():
    assert parse_ics_calendar("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n") is None
    assert parse_ics_calendar("") is None
    assert parse_ics_calendar(None) is None
