"""Unit tests for the pure functions in calendar_google + google_auth cache."""
from backend import google_auth
from backend.calendar_google import (
    map_calendar, map_event, to_google_event, _to_rfc3339, _ics_iso,
)


def test_token_cache_expiry_logic(monkeypatch):
    calls = {"n": 0}

    def fake_fetch():
        calls["n"] += 1
        return (f"tok{calls['n']}", 1000.0 + calls["n"])

    monkeypatch.setattr(google_auth, "_fetch_token", fake_fetch)
    google_auth._CACHE["token"] = None
    google_auth._CACHE["exp"] = 0.0
    monkeypatch.setattr(google_auth.time, "time", lambda: 100.0)
    assert google_auth.access_token() == "tok1"
    assert google_auth.access_token() == "tok1"   # cached
    assert calls["n"] == 1
    monkeypatch.setattr(google_auth.time, "time", lambda: 2000.0)
    assert google_auth.access_token() == "tok2"   # expired → refetch
    assert calls["n"] == 2


def test_map_calendar():
    c = map_calendar({"id": "you@example.com", "summary": "Frank",
                      "backgroundColor": "#44a703", "primary": True})
    assert c["href"] == "you@example.com" and c["name"] == "Frank"
    assert c["color"] == "#44a703" and c["hex"] == "#44a703" and c["primary"] is True


def test_map_event_timed_and_all_day():
    t = map_event({"id": "e1", "summary": "Sync", "location": "Zoom",
                   "start": {"dateTime": "2026-06-04T13:00:00-04:00"},
                   "end": {"dateTime": "2026-06-04T13:30:00-04:00"}}, "cal@x", "#1c3eff")
    assert t["uid"] == "e1" and t["all_day"] is False
    assert t["dtstart"] == "2026-06-04T13:00:00-04:00" and t["color"] == "#1c3eff"
    assert t["calendar"] == "cal@x" and t["location"] == "Zoom"
    a = map_event({"id": "e2", "summary": "OOO", "start": {"date": "2026-07-04"},
                   "end": {"date": "2026-07-05"}}, "c", "#e6c800")
    assert a["all_day"] is True and a["dtstart"] == "2026-07-04" and a["dtend"] == "2026-07-05"


def test_to_google_event():
    g = to_google_event({"summary": "X", "dtstart": "2026-06-04T13:00:00-04:00",
                         "dtend": "2026-06-04T13:30:00-04:00", "all_day": False,
                         "location": "Zoom"})
    assert g["start"]["dateTime"] == "2026-06-04T13:00:00-04:00" and g["location"] == "Zoom"
    a = to_google_event({"summary": "Y", "dtstart": "2026-07-04",
                        "dtend": "2026-07-05", "all_day": True})
    assert a["start"]["date"] == "2026-07-04" and "dateTime" not in a["start"]


def test_to_rfc3339_and_ics_iso():
    assert _to_rfc3339("2026-06-04", False) == "2026-06-04T00:00:00Z"
    assert _to_rfc3339("2026-06-04", True) == "2026-06-04T23:59:59Z"
    assert _to_rfc3339("2026-06-04T10:00:00Z", False) == "2026-06-04T10:00:00Z"
    assert _ics_iso("20260704") == "2026-07-04"
    assert _ics_iso("20260704T130000Z") == "2026-07-04T13:00:00Z"
