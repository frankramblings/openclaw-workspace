"""Settings: read-only Connections + MCP-servers view.

Surfaces what's actually wired — email (himalaya), calendar (Google), and the
OpenClaw MCP servers (via mcporter) — so the Settings tab reflects reality. All
read-only: no gateway config writes, so no risk to the gateway/Signal. The
email/calendar config is managed by their own wiring (himalaya config.toml,
google-calendar-mcp), so the POST/save endpoints are graceful no-ops.
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import time
import tomllib
from pathlib import Path

from fastapi import APIRouter, Body

router = APIRouter()

_HIMALAYA_CONFIG = Path(os.environ.get(
    "HIMALAYA_CONFIG", Path.home() / ".config" / "himalaya" / "config.toml"))
_MCPORTER_BIN = os.environ.get("MCPORTER_BIN") or shutil.which("mcporter") or "mcporter"
_MCPORTER_CONFIG = Path(os.environ.get(
    "OPENCLAW_MCPORTER_CONFIG",
    Path.home() / ".openclaw" / "workspace" / "config" / "mcporter.json"))
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


# --- MCP servers (via mcporter; OpenClaw's local servers only) ---------------

_MCP_CACHE: dict = {"data": None, "ts": 0.0}
_MCP_TTL = 30.0


async def _mcporter_json() -> dict:
    """Run `mcporter list --json` against the OpenClaw config (cached)."""
    if _MCP_CACHE["data"] is not None and time.time() - _MCP_CACHE["ts"] < _MCP_TTL:
        return _MCP_CACHE["data"]
    proc = await asyncio.create_subprocess_exec(
        _MCPORTER_BIN, "list", "--config", str(_MCPORTER_CONFIG), "--json",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=40)
        data = json.loads(out.decode() or "{}")
    except Exception:  # noqa: BLE001
        data = {"servers": []}
    _MCP_CACHE["data"], _MCP_CACHE["ts"] = data, time.time()
    return data


def _is_local(srv: dict) -> bool:
    """Keep OpenClaw's own servers; drop imports (e.g. ramblebot from ~/.claude.json)."""
    return (srv.get("source") or {}).get("kind") == "local"


def _map_server(srv: dict) -> dict:
    status = srv.get("status") or "unknown"
    tools = srv.get("tools")
    n_tools = len(tools) if isinstance(tools, list) else 0
    return {
        "id": srv.get("name"),
        "name": srv.get("description") or srv.get("name"),
        "status": status,                       # ok | offline | auth | error
        "is_enabled": True,                     # present in the config = enabled
        "needs_oauth": status == "auth",
        "tool_count": n_tools,
        "enabled_tool_count": n_tools,
        "error": srv.get("error") or srv.get("issue") or None,
        "transport": srv.get("transport"),
    }


@router.get("/api/mcp/servers")
async def mcp_servers():
    data = await _mcporter_json()
    servers = [_map_server(s) for s in data.get("servers", []) if _is_local(s)]
    return {"servers": servers}


@router.get("/api/mcp/servers/{server_id}/tools")
async def mcp_server_tools(server_id: str):
    data = await _mcporter_json()
    for s in data.get("servers", []):
        if s.get("name") == server_id:
            tools = s.get("tools") if isinstance(s.get("tools"), list) else []
            return {"tools": [{"name": t.get("name") if isinstance(t, dict) else t,
                               "description": (t.get("description") if isinstance(t, dict) else "")}
                              for t in tools]}
    return {"tools": []}


@router.post("/api/mcp/servers/{server_id}/reconnect")
async def mcp_reconnect(server_id: str):
    _MCP_CACHE["ts"] = 0.0          # force a fresh probe on the next list
    await _mcporter_json()
    return {"ok": True}
