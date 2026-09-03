"""Status and audit for the agent-config surfaces (MCP servers, skill
proposals, agent files): what the kill switch says, which agent is the
default, where backups live, and the recent write log."""
from __future__ import annotations

from fastapi import APIRouter

from . import agent_config_store as store
from . import gateway_admin as gw

router = APIRouter()


@router.get("/api/agent-config/status")
async def status():
    try:
        agent_id = await gw.default_agent_id()
    except Exception:  # noqa: BLE001
        agent_id = None
    return {"ok": True, "writes_enabled": store.writes_enabled(), "agent_id": agent_id,
            "backups_dir": str(store.base_dir() / "backups"), "audit_entries": store.count_audit()}


@router.get("/api/agent-config/audit")
async def audit(limit: int = 50):
    if not 1 <= limit <= 500:
        return gw.fail(400, "bad_request", "limit must be 1..500")
    return {"ok": True, "entries": store.recent_audit(limit)}
