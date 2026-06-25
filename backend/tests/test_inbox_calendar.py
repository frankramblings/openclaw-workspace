"""Unit tests for the calendar-invites collector + RSVP write-back.

Covers the pure pieces (no network): is_pending_invite filtering, apply_rsvp
body building, and the source map_items shape — plus the rsvp() orchestration
with a faked Google client.
"""
import asyncio

from backend import calendar_google as cg
from backend.inbox.sources import calendar

NOW = 1_750_000_000_000


def _event(rstatus="needsAction", status="confirmed", self_present=True,
           start="2026-06-26T15:00:00Z"):
    attendees = [{"email": "barry@acme.com", "responseStatus": "accepted"}]
    if self_present:
        attendees.insert(0, {"email": "me@x.com", "self": True,
                             "responseStatus": rstatus})
    return {
        "id": "evt1", "summary": "Sync with Barry", "status": status,
        "start": {"dateTime": start}, "end": {"dateTime": "2026-06-26T15:30:00Z"},
        "organizer": {"email": "barry@acme.com", "displayName": "Barry Epstein"},
        "location": "Zoom", "htmlLink": "https://cal/evt1",
        "attendees": attendees,
    }


def test_is_pending_invite():
    assert cg.is_pending_invite(_event()) is True
    assert cg.is_pending_invite(_event(rstatus="accepted")) is False
    assert cg.is_pending_invite(_event(status="cancelled")) is False
    assert cg.is_pending_invite(_event(self_present=False)) is False  # no self attendee


def test_apply_rsvp_sets_only_self():
    body = cg.apply_rsvp(_event(), "yes")
    mine = [a for a in body["attendees"] if a.get("self")][0]
    other = [a for a in body["attendees"] if not a.get("self")][0]
    assert mine["responseStatus"] == "accepted"
    assert other["responseStatus"] == "accepted"   # untouched (was already accepted)
    assert cg.apply_rsvp(_event(), "maybe")["attendees"][0]["responseStatus"] == "tentative"
    assert cg.apply_rsvp(_event(), "no")["attendees"][0]["responseStatus"] == "declined"


def test_apply_rsvp_rejects_bad_input():
    for bad in ("", "bogus", None):
        try:
            cg.apply_rsvp(_event(), bad)
            assert False, f"expected ValueError for {bad!r}"
        except ValueError:
            pass
    # not an attendee → can't RSVP
    try:
        cg.apply_rsvp(_event(self_present=False), "yes")
        assert False, "expected ValueError when not an attendee"
    except ValueError:
        pass


def test_map_items_shape():
    items = calendar.map_items([_event()], now_ms=NOW)
    assert len(items) == 1
    it = items[0]
    assert it["source"] == "calendar"
    assert it["actions"] == ["rsvp", "dismiss", "snooze"]
    assert it["title"] == "Sync with Barry"
    assert it["meta"]["event_id"] == "evt1"
    assert it["meta"]["calendar"] == "primary"
    assert it["meta"]["isInvite"] is True
    assert "Barry Epstein" in it["snippet"]


def test_map_items_scores_sooner_higher():
    soon = _event(start="2026-06-15T15:00:00Z")          # ~within a day of NOW
    soon["id"] = "soon"
    later = _event(start="2026-08-01T15:00:00Z")          # weeks out
    later["id"] = "later"
    items = calendar.map_items([later, soon], now_ms=NOW)
    assert items[0]["id"] == "soon"                       # sorted soonest-first
    assert items[0]["score"] >= items[1]["score"]


def test_rsvp_reads_then_patches_with_sendupdates(monkeypatch):
    calls = {}

    async def fake_get(path, params=None):
        calls["get"] = path
        return _event()

    async def fake_patch(path, body, params=None):
        calls["patch"] = path
        calls["body"] = body
        calls["params"] = params
        return {"ok": True}

    monkeypatch.setattr(cg, "_get", fake_get)
    monkeypatch.setattr(cg, "_patch", fake_patch)
    asyncio.run(cg.rsvp("evt1", "primary", "no"))
    assert "/events/evt1" in calls["get"]
    assert "/events/evt1" in calls["patch"]
    assert calls["params"] == {"sendUpdates": "all"}
    mine = [a for a in calls["body"]["attendees"] if a.get("self")][0]
    assert mine["responseStatus"] == "declined"


if __name__ == "__main__":
    import inspect
    import sys

    class _MP:
        """Minimal monkeypatch stand-in so the file also runs under plain
        `python3` (the repo has no pytest-asyncio; tests double as scripts)."""
        def __init__(self):
            self._undo = []

        def setattr(self, obj, name, val):
            self._undo.append((obj, name, getattr(obj, name)))
            setattr(obj, name, val)

        def undo(self):
            for obj, name, old in reversed(self._undo):
                setattr(obj, name, old)
            self._undo = []

    failed = 0
    for fn_name, fn in sorted(globals().items()):
        if not fn_name.startswith("test_") or not callable(fn):
            continue
        mp = _MP()
        try:
            if "monkeypatch" in inspect.signature(fn).parameters:
                fn(mp)
            else:
                fn()
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn_name}: {exc}")
        finally:
            mp.undo()
    if failed:
        print(f"calendar: {failed} FAILED")
        sys.exit(1)
    print("inbox-calendar: all assertions OK")
