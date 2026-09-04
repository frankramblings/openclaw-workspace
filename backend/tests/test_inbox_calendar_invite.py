"""Pure parse/build tests for calendar_invite (no I/O)."""
import pytest
from httpx import ASGITransport, AsyncClient

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


def test_build_reply_accepted():
    inv = ci.extract_invite(GOOGLE_INVITE)
    out = ci.build_reply(inv, "me@example.com", "accepted", "20260609T120000Z")
    assert "METHOD:REPLY" in out
    assert "UID:abc-123@google.com" in out
    assert "SEQUENCE:2" in out
    assert "ORGANIZER;CN=Boss:mailto:boss@example.com" in out
    assert "ATTENDEE;PARTSTAT=ACCEPTED;CN=me@example.com:mailto:me@example.com" in out
    assert "DTSTART;TZID=America/New_York:20260610T100000" in out
    assert "DTSTAMP:20260609T120000Z" in out
    assert out.startswith("BEGIN:VCALENDAR")
    assert out.rstrip().endswith("END:VCALENDAR")


def test_build_reply_rejects_bad_status():
    inv = ci.extract_invite(GOOGLE_INVITE)
    with pytest.raises(ci.CalendarError):
        ci.build_reply(inv, "me@example.com", "perhaps", "20260609T120000Z")


def test_reply_subject():
    assert ci.reply_subject("accepted", "Sync") == "Accepted: Sync"
    assert ci.reply_subject("tentative", "Sync") == "Tentative: Sync"
    assert ci.reply_subject("declined", "Sync") == "Declined: Sync"


def test_build_reply_folds_multibyte_summary_without_loss():
    inv = dict(ci.extract_invite(GOOGLE_INVITE),
               summary="週次チームミーティング" * 4)  # long non-ASCII SUMMARY
    out = ci.build_reply(inv, "me@example.com", "accepted", "20260609T120000Z")
    unfolded = out.replace("\r\n ", "")           # reverse RFC 5545 folding
    assert "SUMMARY:" + "週次チームミーティング" * 4 in unfolded


def test_is_invite_candidate():
    from backend import email_himalaya as eh
    assert eh.is_invite_candidate("Invitation: Sync @ Tue", True, "b@x.com")
    assert eh.is_invite_candidate("Updated invitation: Sync", True, "b@x.com")
    assert not eh.is_invite_candidate("Invitation: Sync", False, "b@x.com")  # no attachment
    assert not eh.is_invite_candidate("Lunch?", True, "b@x.com")             # no pattern


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_email_rsvp_endpoint(monkeypatch):
    from backend import email_himalaya as eh
    calls = {}

    async def fake_perform(uid, folder, status):
        calls["args"] = (uid, folder, status)
        return {"status": status, "moved_to": eh.ARCHIVE_FOLDER}

    monkeypatch.setattr(eh, "perform_rsvp", fake_perform)
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://t") as c:
        r = await c.post("/api/email/rsvp/42", json={"rsvp": "accepted"})
    assert r.json() == {"ok": True, "status": "accepted",
                        "moved_to": eh.ARCHIVE_FOLDER}
    assert calls["args"] == ("42", "INBOX", "accepted")


@pytest.mark.anyio
async def test_email_rsvp_rejects_bad_status(monkeypatch):
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://t") as c:
        r = await c.post("/api/email/rsvp/42", json={"rsvp": "nope"})
    assert r.status_code == 400


def test_read_view_exposes_display_calendar_and_invite():
    """The read view keeps main's display block and adds the RSVP-ready invite."""
    from backend import email_himalaya as eh
    read = eh.message_to_read(GOOGLE_INVITE, uid="9")
    assert read["calendar"] and read["calendar"]["summary"] == "Sync"
    inv = read["invite"]
    assert inv["method"] == "REQUEST"
    assert inv["uid"] == "abc-123@google.com"
    assert inv["organizer_email"] == "boss@example.com"
    assert inv["dtstart_line"].startswith("DTSTART;TZID=America/New_York:")


def test_read_view_invite_is_none_for_plain_email():
    from backend import email_himalaya as eh
    read = eh.message_to_read(PLAIN_EMAIL, uid="9")
    assert read["invite"] is None


@pytest.mark.anyio
async def test_perform_rsvp_sends_reply_and_files_the_message(monkeypatch):
    """Happy path with every himalaya call faked: no real mail leaves here."""
    from backend import email_himalaya as eh
    sent, flags, moved = {}, [], []

    async def fake_run_raw(args, stdin=None, timeout=None):
        if args[:2] == ["message", "export"]:
            return GOOGLE_INVITE
        if args[:2] == ["message", "send"]:
            sent["mime"] = stdin
            return b""
        if args[:2] == ["flag", "add"]:
            flags.append(args)
            return b""
        if args[0] == "message" and args[1] == "move":
            moved.append(args)
            return b""
        return b""

    monkeypatch.setattr(eh.himalaya_cli, "run_raw", fake_run_raw)
    monkeypatch.setattr(eh, "ACCOUNT_ADDRESS", "me@example.com")
    out = await eh.perform_rsvp("42", "INBOX", "accepted")

    mime = sent["mime"].decode("utf-8", "replace")
    assert "METHOD:REPLY" in mime
    assert "PARTSTAT=ACCEPTED" in mime
    assert "UID:abc-123@google.com" in mime
    assert "Subject: Accepted: Sync" in mime
    assert "To: boss@example.com" in mime
    assert flags and flags[0][:4] == ["flag", "add", "42", "Seen"]
    assert moved
    assert out == {"status": "accepted", "moved_to": eh.ARCHIVE_FOLDER}


@pytest.mark.anyio
async def test_email_rsvp_returns_404_when_the_email_has_no_invite(monkeypatch):
    from backend import email_himalaya as eh

    async def fake_run_raw(args, stdin=None, timeout=None):
        return PLAIN_EMAIL

    monkeypatch.setattr(eh.himalaya_cli, "run_raw", fake_run_raw)
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://t") as c:
        r = await c.post("/api/email/rsvp/42", json={"rsvp": "accepted"})
    assert r.status_code == 404
    assert r.json()["ok"] is False
