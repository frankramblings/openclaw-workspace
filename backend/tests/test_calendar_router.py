"""The calendar router dispatches to the configured provider."""
import asyncio

from backend import calendar as cal


def test_provider_module_google(monkeypatch):
    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "google")
    assert cal._provider() is cal.calendar_google


def test_provider_module_caldav(monkeypatch):
    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "caldav")
    assert cal._provider() is cal.calendar_caldav


def test_calendars_endpoint_uses_provider(monkeypatch):
    async def fake_list():
        return [{"href": "x", "name": "X", "color": "#1", "hex": "#1", "primary": False}]
    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "caldav")
    monkeypatch.setattr(cal.calendar_caldav, "list_calendars", fake_list)
    out = asyncio.run(cal.calendars())
    assert out == {"calendars": [{"href": "x", "name": "X", "color": "#1",
                                  "hex": "#1", "primary": False}]}


# --- Bug 2 router fix: delete must not hardcode "primary" for CalDAV ----------

def test_router_delete_passes_none_to_caldav_when_no_param(monkeypatch):
    """Router delete with no ?calendar= must pass None to CalDAV, not 'primary'."""
    from fastapi.testclient import TestClient
    from backend.app import app

    received = {}

    async def fake_delete(uid, calendar):
        received["uid"] = uid
        received["calendar"] = calendar
        return {"ok": True, "deleted": [uid]}

    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "caldav")
    monkeypatch.setattr(cal.calendar_caldav, "delete_event", fake_delete)

    client = TestClient(app, raise_server_exceptions=True)
    resp = client.delete("/api/calendar/events/uid123")
    assert resp.status_code == 200
    assert received["uid"] == "uid123"
    # calendar param must be None (or falsy), NOT the string "primary"
    assert received["calendar"] is None or received["calendar"] == ""


def test_router_delete_passes_calendar_param_when_provided(monkeypatch):
    """Router delete with ?calendar=<href> passes it through to the provider."""
    from fastapi.testclient import TestClient
    from backend.app import app

    received = {}

    async def fake_delete(uid, calendar):
        received["uid"] = uid
        received["calendar"] = calendar
        return {"ok": True, "deleted": [uid]}

    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "caldav")
    monkeypatch.setattr(cal.calendar_caldav, "delete_event", fake_delete)

    client = TestClient(app, raise_server_exceptions=True)
    coll = "https://dav.example/cal/personal/"
    resp = client.delete(f"/api/calendar/events/uid456?calendar={coll}")
    assert resp.status_code == 200
    assert received["calendar"] == coll


def test_router_delete_google_still_gets_primary_default(monkeypatch):
    """Google delete_event still defaults to 'primary' (via its own logic)."""
    from fastapi.testclient import TestClient
    from backend.app import app

    received = {}

    async def fake_google_delete(uid, calendar):
        received["uid"] = uid
        received["calendar"] = calendar
        return {"ok": True, "deleted": [uid]}

    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "google")
    monkeypatch.setattr(cal.calendar_google, "delete_event", fake_google_delete)

    client = TestClient(app, raise_server_exceptions=True)
    resp = client.delete("/api/calendar/events/evid")
    assert resp.status_code == 200
    # Router passes None; Google's own delete_event defaults it to "primary"
    assert received["calendar"] is None or received["calendar"] == ""
