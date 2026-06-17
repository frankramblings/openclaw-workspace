"""Which tabs are usable on THIS install. Core (OpenClaw-native) tabs are always
on; account-specific tabs require their tool/config AND being enabled in
connection.json's "integrations". Drives /api/capabilities so the frontend can
hide/disable what won't work instead of erroring."""
from __future__ import annotations

import os
import shutil
from pathlib import Path

from . import calendar_config, config
from .inbox import settings as _inbox_settings

CORE_TABS = ["chat", "memory", "skills", "cron", "sessions", "notes", "documents", "models"]


def _enabled(name: str) -> bool:
    return bool(config.load_connection().get("integrations", {}).get(name))


def _himalaya_config_present() -> bool:
    cfg = os.environ.get("HIMALAYA_CONFIG") or str(
        Path.home() / ".config" / "himalaya" / "config.toml")
    return Path(cfg).expanduser().exists()


def _avail(ok, reason="", hint=""):
    return {"available": bool(ok), "reason": reason, "hint": hint}


def _email() -> dict:
    if not shutil.which(os.environ.get("HIMALAYA_BIN") or "himalaya"):
        return _avail(False, "himalaya not installed",
                      "install himalaya, then: setup.sh --enable email")
    if not _himalaya_config_present():
        return _avail(False, "no himalaya config",
                      "configure ~/.config/himalaya/config.toml")
    if not _enabled("email"):
        return _avail(False, "not enabled", "enable with: setup.sh --enable email")
    return _avail(True)


def _calendar() -> dict:
    if calendar_config.provider() == "caldav":
        s = calendar_config.caldav_settings()
        if not (s["url"] and s["username"] and s["password"]):
            return _avail(False, "CalDAV not configured",
                          "run: setup.sh --add-calendar")
        if not _enabled("calendar"):
            return _avail(False, "not enabled", "enable with: setup.sh --add-calendar")
        return _avail(True)
    # google (default): existing token-file checks
    keys = Path(os.environ.get("GOOGLE_OAUTH_KEYS")
                or Path.home() / ".gmail-mcp/gcp-oauth.keys.json").expanduser()
    toks = Path(os.environ.get("GOOGLE_CAL_TOKENS")
                or Path.home() / ".config/google-calendar-mcp/tokens.json").expanduser()
    if not (keys.exists() and toks.exists()):
        return _avail(False, "no Google OAuth creds/tokens",
                      "provide Google OAuth creds, then: setup.sh --add-calendar")
    if not _enabled("calendar"):
        return _avail(False, "not enabled", "enable with: setup.sh --add-calendar")
    return _avail(True)


def _inbox() -> dict:
    if not _enabled("inbox"):
        return _avail(False, "not enabled", "enable with: setup.sh --enable inbox")
    if not _inbox_settings.enabled_collectors():
        return _avail(False, "no collectors configured",
                      "configure .data/inbox.json to enable at least one collector")
    return _avail(True)


def snapshot() -> dict:
    out = {t: _avail(True) for t in CORE_TABS}
    out["email"] = _email()
    out["calendar"] = _calendar()
    out["inbox"] = _inbox()
    return out
