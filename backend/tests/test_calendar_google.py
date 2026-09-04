"""Unit tests for the pure functions in calendar_google + google_auth cache."""
import asyncio
import datetime
import threading

import httpx

from backend import calendar_google, google_auth
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


def test_http_client_is_shared_and_recreated_when_closed():
    import asyncio
    from backend import calendar_google as cg

    async def main():
        c1 = cg._http()
        c2 = cg._http()
        assert c1 is c2          # one client, reused across calls
        await c1.aclose()
        c3 = cg._http()
        assert c3 is not c1      # closed → lazily recreated
        await c3.aclose()

    asyncio.run(main())


def test_list_calendars_maps_canonical(monkeypatch):
    import asyncio
    from backend import calendar_google as cg
    async def fake_get(path, params=None):
        return {"items": [{"id": "primary", "summary": "Me", "primary": True,
                           "backgroundColor": "#123456"}]}
    monkeypatch.setattr(cg, "_get", fake_get)
    cals = asyncio.run(cg.list_calendars())
    assert cals == [{"href": "primary", "name": "Me", "color": "#123456",
                     "hex": "#123456", "primary": True}]


# --- events range defaults and per-calendar error reporting -------------------

def _fake_google(monkeypatch, handler):
    """Point calendar_google's shared client at a MockTransport and stub auth."""
    monkeypatch.setattr(google_auth, "access_token", lambda: "tok")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    monkeypatch.setattr(calendar_google, "_http", lambda: client)
    return client


def test_bare_events_request_sends_a_real_60_day_range(monkeypatch):
    """An absent range used to forward empty timeMin/timeMax, which Google
    answers 400 for every calendar (the client then saw an empty calendar)."""
    seen = {}

    def handler(request):
        if request.url.path.endswith("/users/me/calendarList"):
            return httpx.Response(200, json={"items": [{"id": "c1", "backgroundColor": "#111"}]})
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"items": []})

    _fake_google(monkeypatch, handler)
    asyncio.run(calendar_google.list_events("", ""))
    assert seen["timeMin"] and seen["timeMax"]
    lo = datetime.datetime.fromisoformat(seen["timeMin"].replace("Z", "+00:00"))
    hi = datetime.datetime.fromisoformat(seen["timeMax"].replace("Z", "+00:00"))
    assert (hi - lo).days == 60


def test_one_failing_calendar_reports_an_error_and_keeps_the_others(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/users/me/calendarList"):
            return httpx.Response(200, json={"items": [
                {"id": "good", "backgroundColor": "#111"},
                {"id": "bad", "backgroundColor": "#222"},
            ]})
        if "/bad/" in str(request.url):
            return httpx.Response(400, json={"error": "nope"})
        return httpx.Response(200, json={"items": [
            {"id": "e1", "summary": "Sync", "start": {"date": "2026-07-04"},
             "end": {"date": "2026-07-05"}},
        ]})

    _fake_google(monkeypatch, handler)
    out = asyncio.run(calendar_google.list_events("", ""))
    assert [e["uid"] for e in out["events"]] == ["e1"]
    assert len(out["errors"]) == 1
    assert out["errors"][0]["calendar"] == "bad"
    assert out["errors"][0]["error"]


def test_access_token_refreshes_once_under_concurrent_cold_misses(monkeypatch):
    """~18 concurrent misses on a cold process each ran a blocking OAuth
    refresh; one lock plus a re-read after acquiring collapses them to one."""
    calls = {"n": 0}
    gate = threading.Event()

    def fake_fetch():
        gate.wait(2)
        calls["n"] += 1
        return ("tok", 1e12)

    monkeypatch.setattr(google_auth, "_fetch_token", fake_fetch)
    google_auth._CACHE["token"] = None
    google_auth._CACHE["exp"] = 0.0
    out = []
    try:
        threads = [threading.Thread(target=lambda: out.append(google_auth.access_token()))
                   for _ in range(18)]
        for t in threads:
            t.start()
        gate.set()
        for t in threads:
            t.join(5)
        assert calls["n"] == 1
        assert out == ["tok"] * 18
    finally:
        # This test parks a far-future expiry in the module-level cache; leave
        # it and every later test silently reuses "tok" instead of refreshing.
        google_auth._CACHE["token"] = None
        google_auth._CACHE["exp"] = 0.0


def test_half_open_ranges_anchor_on_the_bound_they_were_given(monkeypatch):
    """start-only or end-only must not produce timeMax < timeMin."""
    seen = {}

    def handler(request):
        if request.url.path.endswith("/users/me/calendarList"):
            return httpx.Response(200, json={"items": [{"id": "c1", "backgroundColor": "#111"}]})
        seen.update(dict(request.url.params))
        return httpx.Response(200, json={"items": []})

    _fake_google(monkeypatch, handler)
    iso = lambda v: datetime.datetime.fromisoformat(v.replace("Z", "+00:00"))

    asyncio.run(calendar_google.list_events("2030-01-10", ""))
    lo, hi = iso(seen["timeMin"]), iso(seen["timeMax"])
    assert seen["timeMin"] == "2030-01-10T00:00:00Z"
    assert hi > lo and (hi - lo).days == 60

    seen.clear()
    asyncio.run(calendar_google.list_events("", "2030-01-10"))
    lo, hi = iso(seen["timeMin"]), iso(seen["timeMax"])
    assert seen["timeMax"] == "2030-01-10T23:59:59Z"
    assert hi > lo and (hi - lo).days == 60
