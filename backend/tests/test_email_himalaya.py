"""Unit tests for the pure functions in email_himalaya (no himalaya/network)."""
from backend.email_himalaya import envelope_to_email, _norm_date


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
