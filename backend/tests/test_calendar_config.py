"""Calendar provider selection + CalDAV settings (env > .data/calendar.json > default)."""
import json

import pytest

from backend import calendar_config as cc


@pytest.fixture
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "CALENDAR_PATH", tmp_path / "calendar.json")
    monkeypatch.setattr(cc, "SECRET_PATH", tmp_path / "secrets" / "caldav-password")
    for v in ("CALENDAR_PROVIDER", "CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"):
        monkeypatch.delenv(v, raising=False)
    return monkeypatch


def test_default_provider_is_google(iso):
    assert cc.provider() == "google"


def test_provider_from_file(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps({"provider": "caldav"}))
    assert cc.provider() == "caldav"


def test_provider_env_wins(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps({"provider": "caldav"}))
    iso.setenv("CALENDAR_PROVIDER", "google")
    assert cc.provider() == "google"


def test_caldav_settings_from_file_and_secret(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps(
        {"provider": "caldav", "caldav": {"url": "https://d.example/cal/", "username": "u"}}))
    sp = tmp_path / "secrets" / "caldav-password"
    sp.parent.mkdir(parents=True)
    sp.write_text("pw")
    s = cc.caldav_settings()
    assert s == {"url": "https://d.example/cal/", "username": "u", "password": "pw"}


def test_caldav_password_env_wins(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps(
        {"caldav": {"url": "https://d.example/cal/", "username": "u"}}))
    iso.setenv("CALDAV_PASSWORD", "envpw")
    assert cc.caldav_settings()["password"] == "envpw"
