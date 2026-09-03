"""Behavioral tests for settings_status.py (Connections view).

email_config/calendar_config read real on-disk config files (himalaya
config.toml, the Google-calendar-mcp tokens.json) — tested against tmp files,
no faking needed.
"""
from __future__ import annotations

import json
import textwrap

import pytest
from fastapi.testclient import TestClient

from backend import settings_status


@pytest.fixture
def anyio_backend():
    return "asyncio"


# --- /api/email/config: himalaya config.toml ---------------------------------

@pytest.mark.anyio
async def test_email_config_reads_himalaya_account_shape(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text(textwrap.dedent("""\
        [accounts.gmail]
        email = "me@gmail.com"
        default = true

        [accounts.gmail.backend]
        type = "imap"
        host = "imap.gmail.com"
        port = 993

        [accounts.gmail.message.send.backend]
        type = "smtp"
        host = "smtp.gmail.com"
        port = 465
        """))
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", cfg)

    out = await settings_status.email_config()

    assert out == {
        "enabled": True, "provider": "himalaya", "address": "me@gmail.com",
        "imap_host": "imap.gmail.com", "imap_port": 993,
        "smtp_host": "smtp.gmail.com", "smtp_port": 465,
    }
    assert isinstance(out["imap_port"], int) and isinstance(out["smtp_port"], int)


@pytest.mark.anyio
async def test_email_config_missing_file_is_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", tmp_path / "nope.toml")
    assert await settings_status.email_config() == {"enabled": False}


@pytest.mark.anyio
async def test_email_config_corrupt_toml_is_disabled_not_raised(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text("not [ valid toml")
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", cfg)
    assert await settings_status.email_config() == {"enabled": False}


@pytest.mark.anyio
async def test_email_config_valid_toml_without_accounts_table_still_enabled(tmp_path, monkeypatch):
    cfg = tmp_path / "config.toml"
    cfg.write_text("# valid toml, no [accounts.*] table\n")
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", cfg)

    out = await settings_status.email_config()

    assert out["enabled"] is True
    assert out["address"] == "" and out["imap_host"] == ""


@pytest.mark.anyio
async def test_email_config_save_is_a_managed_externally_ack():
    out = await settings_status.email_config_save({"host": "ignored"})
    assert out == {"ok": True, "managed_externally": True}


# --- /api/calendar/config: reused Google token file --------------------------

@pytest.mark.anyio
async def test_calendar_config_reads_normal_account_shape(tmp_path, monkeypatch):
    tok = tmp_path / "tokens.json"
    tok.write_text(json.dumps({"normal": {"scope": "https://www.googleapis.com/auth/calendar"}}))
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tok)

    out = await settings_status.calendar_config()

    assert out == {"enabled": True, "provider": "google", "type": "google",
                   "connected": True, "scope": "https://www.googleapis.com/auth/calendar"}


@pytest.mark.anyio
async def test_calendar_config_falls_back_to_first_account_without_normal_key(tmp_path, monkeypatch):
    tok = tmp_path / "tokens.json"
    tok.write_text(json.dumps({"work": {"scope": "cal.readonly"}}))
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tok)

    out = await settings_status.calendar_config()

    assert out["scope"] == "cal.readonly"


@pytest.mark.anyio
async def test_calendar_config_missing_file_is_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tmp_path / "nope.json")
    assert await settings_status.calendar_config() == {"enabled": False}


@pytest.mark.anyio
async def test_calendar_config_corrupt_json_is_disabled_not_raised(tmp_path, monkeypatch):
    tok = tmp_path / "tokens.json"
    tok.write_text("{not valid json")
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tok)
    assert await settings_status.calendar_config() == {"enabled": False}


@pytest.mark.anyio
async def test_calendar_config_save_is_a_managed_externally_ack():
    out = await settings_status.calendar_config_save({})
    assert out == {"ok": True, "managed_externally": True}


# --- routes wired into the real app -------------------------------------------

def test_route_email_config_wired_into_app(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_HIMALAYA_CONFIG", tmp_path / "nope.toml")
    from backend.app import app
    client = TestClient(app)
    r = client.get("/api/email/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": False}


def test_route_calendar_config_wired_into_app(tmp_path, monkeypatch):
    monkeypatch.setattr(settings_status, "_GCAL_TOKENS", tmp_path / "nope.json")
    from backend.app import app
    client = TestClient(app)
    r = client.get("/api/calendar/config")
    assert r.status_code == 200
    assert r.json() == {"enabled": False}
