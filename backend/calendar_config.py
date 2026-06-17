"""Which calendar provider to use, and the CalDAV connection settings.
Non-secret bits live in .data/calendar.json; the CalDAV password lives in a
mode-600 secret file (or CALDAV_PASSWORD env) — never in the JSON, mirroring the
Phase-1 connection.json discipline. Default provider 'google' keeps the
maintainer's existing setup working untouched."""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import config

CALENDAR_PATH = config.DATA_DIR / "calendar.json"
SECRET_PATH = config.DATA_DIR / "secrets" / "caldav-password"


def _load() -> dict:
    try:
        return json.loads(CALENDAR_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def provider() -> str:
    return (os.environ.get("CALENDAR_PROVIDER") or _load().get("provider") or "google")


def _password() -> str:
    env = os.environ.get("CALDAV_PASSWORD")
    if env:
        return env
    try:
        return SECRET_PATH.read_text().strip()
    except FileNotFoundError:
        return ""


def caldav_settings() -> dict:
    cd = _load().get("caldav") or {}
    return {
        "url": os.environ.get("CALDAV_URL") or cd.get("url") or "",
        "username": os.environ.get("CALDAV_USERNAME") or cd.get("username") or "",
        "password": _password(),
    }
