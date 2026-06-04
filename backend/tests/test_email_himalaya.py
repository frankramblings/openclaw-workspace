"""Unit tests for the pure functions in email_himalaya (no himalaya/network)."""
from backend.email_himalaya import (
    envelope_to_email, _norm_date, folders_from_himalaya, build_mime,
    message_to_read,
)


def test_folders_from_himalaya():
    assert folders_from_himalaya(
        [{"name": "INBOX"}, {"name": "[Gmail]/Sent Mail"}]) == ["INBOX", "[Gmail]/Sent Mail"]
    assert folders_from_himalaya(["INBOX", "Work"]) == ["INBOX", "Work"]
    assert folders_from_himalaya([{"desc": "x"}]) == []   # no name → dropped


def test_build_mime_basic_and_threading():
    raw = build_mime(from_addr="me@x.com", to="a@b.com", cc=None, bcc=None,
                     subject="Hi", body="hello", body_html=None,
                     in_reply_to="<abc@x>", references="<abc@x>").decode()
    assert "To: a@b.com" in raw and "Subject: Hi" in raw and "hello" in raw
    assert "From: me@x.com" in raw
    assert "In-Reply-To: <abc@x>" in raw and "References: <abc@x>" in raw


def test_message_to_read_parses_rfc822():
    eml = (b"From: Jane <jane@x.com>\r\nTo: me@x.com\r\n"
           b"Subject: Hi\r\nMessage-ID: <m1@x>\r\n"
           b"Content-Type: text/plain\r\n\r\nhello body\r\n")
    r = message_to_read(eml, uid="42")
    assert r["uid"] == "42"
    assert r["subject"] == "Hi"
    assert r["from_address"] == "jane@x.com"
    assert r["from_name"] == "Jane"
    assert r["message_id"] == "<m1@x>"
    assert "hello body" in r["body"]


def test_norm_date_space_to_iso():
    # himalaya emits "2026-06-04 11:45+00:00"; JS Date wants the T separator.
    assert _norm_date("2026-06-04 11:45+00:00") == "2026-06-04T11:45+00:00"
    assert _norm_date("") == ""


def test_envelope_to_email_basic():
    env = {"id": "42", "flags": ["Seen"], "subject": "Hi",
           "from": {"name": "Jane Doe", "addr": "jane@x.com"},
           "date": "2026-06-04 12:00+00:00", "has_attachment": True}
    e = envelope_to_email(env)
    assert e["uid"] == "42"
    assert e["subject"] == "Hi"
    assert e["from_name"] == "Jane Doe"
    assert e["from_address"] == "jane@x.com"
    assert e["is_read"] is True
    assert e["has_attachments"] is True
    assert e["is_answered"] is False
    assert e["tags"] == []
    assert e["date"] == "2026-06-04T12:00+00:00"


def test_envelope_to_email_unseen_unanswered_addr_fallback():
    e = envelope_to_email({"id": "7", "flags": [], "subject": "",
                           "from": {"name": None, "addr": "a@b.c"}, "date": ""})
    assert e["is_read"] is False
    assert e["is_answered"] is False
    assert e["from_name"] == "a@b.c"   # name None → falls back to address
    assert e["subject"] == "(no subject)"
