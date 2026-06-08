"""Pure parse/build tests for calendar_invite (no I/O)."""
from backend.inbox import calendar_invite as ci

GOOGLE_INVITE = (
    b"From: Boss <boss@example.com>\r\n"
    b"To: me@example.com\r\n"
    b"Subject: Invitation: Sync @ Tue\r\n"
    b'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"\r\n'
    b"\r\n"
    b"BEGIN:VCALENDAR\r\n"
    b"VERSION:2.0\r\n"
    b"METHOD:REQUEST\r\n"
    b"BEGIN:VEVENT\r\n"
    b"UID:abc-123@google.com\r\n"
    b"SEQUENCE:2\r\n"
    b"DTSTART;TZID=America/New_York:20260610T100000\r\n"
    b"DTEND;TZID=America/New_York:20260610T103000\r\n"
    b"ORGANIZER;CN=Boss:mailto:boss@example.com\r\n"
    b"SUMMARY:Sync\r\n"
    b"LOCATION:Room 4\r\n"
    b"END:VEVENT\r\n"
    b"END:VCALENDAR\r\n"
)

PLAIN_EMAIL = (
    b"From: a@example.com\r\nSubject: hi\r\n"
    b"Content-Type: text/plain\r\n\r\nnot an invite\r\n"
)


def test_extract_invite_parses_google_request():
    inv = ci.extract_invite(GOOGLE_INVITE)
    assert inv is not None
    assert inv["uid"] == "abc-123@google.com"
    assert inv["sequence"] == 2
    assert inv["summary"] == "Sync"
    assert inv["location"] == "Room 4"
    assert inv["organizer_email"] == "boss@example.com"
    assert inv["organizer_line"] == "ORGANIZER;CN=Boss:mailto:boss@example.com"
    assert inv["dtstart_line"] == "DTSTART;TZID=America/New_York:20260610T100000"
    assert inv["dtend_line"] == "DTEND;TZID=America/New_York:20260610T103000"


def test_extract_invite_returns_none_for_plain_email():
    assert ci.extract_invite(PLAIN_EMAIL) is None


ALLDAY_INVITE = (
    b"From: Boss <boss@example.com>\r\n"
    b"Subject: Invitation: Holiday\r\n"
    b'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"\r\n'
    b"\r\n"
    b"BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nBEGIN:VEVENT\r\n"
    b"UID:allday-1@google.com\r\n"
    b"DTSTART;VALUE=DATE:20260610\r\n"
    b"DTEND;VALUE=DATE:20260611\r\n"
    b"ORGANIZER:mailto:boss@example.com\r\n"
    b"SUMMARY:Holiday\r\n"
    b"END:VEVENT\r\nEND:VCALENDAR\r\n"
)


def test_extract_invite_allday_date_only():
    inv = ci.extract_invite(ALLDAY_INVITE)
    assert inv is not None
    assert inv["start_iso"] == "2026-06-10"
    assert inv["end_iso"] == "2026-06-11"
    assert inv["organizer_email"] == "boss@example.com"   # bare ORGANIZER:mailto:
