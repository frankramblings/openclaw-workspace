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
