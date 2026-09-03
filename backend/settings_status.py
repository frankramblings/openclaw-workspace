"""Settings: read-only Connections view.

Surfaces what's actually wired: email (himalaya) and calendar (Google), so
the Settings tab reflects reality. All read-only: no gateway config writes, so
no risk to the gateway/Signal. The email/calendar config is managed by their
own wiring (himalaya config.toml, google-calendar-mcp), so the POST/save
endpoints are graceful no-ops. (MCP servers moved to mcp_servers.py, which
reads/writes them through the gateway's own config.get/config.patch instead
of shelling out to mcporter.)
"""
from __future__ import annotations

import json
import os
import tomllib
from pathlib import Path

from fastapi import APIRouter, Body

router = APIRouter()

_HIMALAYA_CONFIG = Path(os.environ.get(
    "HIMALAYA_CONFIG", Path.home() / ".config" / "himalaya" / "config.toml"))
_GCAL_TOKENS = Path(os.environ.get(
    "GOOGLE_CAL_TOKENS",
    Path.home() / ".config" / "google-calendar-mcp" / "tokens.json"))


# --- email connection status (read himalaya config) --------------------------

@router.get("/api/email/config")
async def email_config():
    try:
        cfg = tomllib.loads(_HIMALAYA_CONFIG.read_text())
        acct = next(iter((cfg.get("accounts") or {}).values()), {})
        backend = acct.get("backend", {})
        send = (acct.get("message", {}).get("send", {})).get("backend", {})
        return {
            "enabled": True,
            "provider": "himalaya",
            "address": acct.get("email", ""),
            "imap_host": backend.get("host", ""),
            "imap_port": backend.get("port"),
            "smtp_host": send.get("host", ""),
            "smtp_port": send.get("port"),
        }
    except Exception:  # noqa: BLE001
        return {"enabled": False}


@router.post("/api/email/config")
async def email_config_save(body: dict = Body(default=None)):
    # Managed by ~/.config/himalaya/config.toml, not the UI. Ack without writing.
    return {"ok": True, "managed_externally": True}


# --- calendar connection status (Google via the reused token) ----------------

@router.get("/api/calendar/config")
async def calendar_config():
    try:
        tok = json.loads(_GCAL_TOKENS.read_text())
        acct = tok.get("normal") or next(iter(tok.values()))
        scope = acct.get("scope", "")
    except Exception:  # noqa: BLE001
        return {"enabled": False}
    return {"enabled": True, "provider": "google", "type": "google",
            "connected": True, "scope": scope}


@router.post("/api/calendar/config")
async def calendar_config_save(body: dict = Body(default=None)):
    return {"ok": True, "managed_externally": True}
