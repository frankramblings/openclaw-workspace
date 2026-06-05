"""Unit tests for the gmail (himalaya) collector's pure mapper."""
from backend.inbox.sources import gmail

NOW = 10**12


def _env(uid="101", subject="Hello", name="Ada", addr="ada@example.com",
         flags=(), age_h=1.0):
    return {"id": uid, "subject": subject,
            "from": {"name": name, "addr": addr},
            "flags": list(flags), "has_attachment": False,
            "date": gmail._iso_from_ms(NOW - int(age_h * 3600_000))}


def test_unread_external_recent_scores_high():
    items = gmail.map_items([_env()], now_ms=NOW)  # unread, external, 1h old
    assert len(items) == 1
    it = items[0]
    assert it["score"] == 3 + 2 + 1   # unread + <6h + external
    assert it["source"] == "gmail"
    assert it["subtitle"] == "Ada"
    assert it["meta"]["uid"] == "101"
    assert it["actions"] == ["archive", "dismiss", "snooze"]


def test_read_unflagged_mail_is_skipped():
    items = gmail.map_items([_env(flags=["Seen"])], now_ms=NOW)
    assert items == []


def test_read_but_flagged_mail_is_kept_with_important_bonus():
    items = gmail.map_items([_env(flags=["Seen", "Flagged"])], now_ms=NOW)
    assert len(items) == 1
    assert items[0]["score"] == 2 + 2 + 1  # important + <6h + external


def test_internal_sender_gets_no_external_bonus():
    items = gmail.map_items([_env(addr="taylor@wistia.com")], now_ms=NOW)
    assert items[0]["score"] == 3 + 2  # unread + <6h
