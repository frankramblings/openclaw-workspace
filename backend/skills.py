"""Skills: the Odysseus skills panel, backed by OpenClaw's real skill registry.

The gateway's `skills.status` returns the agent's full skill set (~60 entries)
with name/description/source/filePath/emoji/disabled/eligible/... We map that
onto the shape the skills.js panel renders, and serve each skill's SKILL.md
from its on-disk `filePath` for the expand-to-read view.

Read-only for v1: list + view markdown. The panel's audit/add/edit actions ack
cleanly so the UI doesn't error, but mutating the on-disk skill set (bundled
under node_modules, or the managed dir) is out of scope here.
"""
from __future__ import annotations

from pathlib import Path

import websockets
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from . import config
from .bridge import _connect_params, _request, _wait_for_challenge

router = APIRouter()

# name -> raw skills.status entry (for filePath lookup on markdown reads).
_by_name: dict[str, dict] = {}


def _map_skill(s: dict) -> dict:
    name = s.get("name", "")
    tags = []
    if s.get("disabled"):
        tags.append("disabled")
    if s.get("always"):
        tags.append("always")
    if s.get("bundled"):
        tags.append("bundled")
    return {
        "id": s.get("skillKey") or name,
        "name": name,
        "description": s.get("description") or "",
        "when_to_use": s.get("description") or "",
        # `status` is the panel's AUDIT status; these skills are un-audited.
        "status": "none",
        "category": s.get("source") or "skill",
        "source": s.get("source") or "",
        "emoji": s.get("emoji") or "",
        "tags": tags,
        "uses": 0,
    }


async def fetch_skills() -> list[dict]:
    """Pull skills.status from the gateway, refresh the filePath cache, map them."""
    url = config.gateway_ws_url()
    async with websockets.connect(url, max_size=None, open_timeout=30,
                                  ping_interval=None) as ws:
        await _wait_for_challenge(ws)
        hello = await _request(ws, "connect", _connect_params())
        if not hello.get("ok"):
            raise RuntimeError(f"gateway connect failed: {hello}")
        res = await _request(ws, "skills.status")
    if not res.get("ok"):
        raise RuntimeError(f"skills.status failed: {res}")
    raw = (res.get("payload") or {}).get("skills") or []
    _by_name.clear()
    for s in raw:
        if s.get("name"):
            _by_name[s["name"]] = s
    return [_map_skill(s) for s in raw]


async def _markdown_for(name: str) -> str | None:
    """Read a skill's SKILL.md off disk via its cached filePath."""
    entry = _by_name.get(name)
    if entry is None:
        try:
            await fetch_skills()
        except Exception:  # noqa: BLE001
            return None
        entry = _by_name.get(name)
    if entry is None:
        return None
    fp = entry.get("filePath")
    if not fp:
        return None
    try:
        return Path(fp).read_text()
    except Exception:  # noqa: BLE001
        return None


# --- routes (literal paths declared before /{name} so they win) --------------

@router.get("/api/skills")
async def get_skills():
    try:
        return {"skills": await fetch_skills()}
    except Exception as exc:  # noqa: BLE001
        return {"skills": [], "error": f"skills unavailable: {exc!r}"}


@router.post("/api/skills/add")
async def add_skill(body: dict = Body(default=None)):
    # Creating on-disk skills is out of scope; ack without error.
    return JSONResponse(status_code=501,
                        content={"detail": "adding skills not supported here"})


@router.post("/api/skills/audit-all")
async def audit_all():
    return {"ok": True, "status": "none", "started": False}


@router.get("/api/skills/audit-all/status")
async def audit_all_status():
    return {"status": "none", "running": False}


@router.post("/api/skills/audit-all/cancel")
async def audit_all_cancel():
    return {"ok": True}


@router.get("/api/skills/builtin")
async def builtin_skills():
    # "Built-in capabilities" is a separate, collapsed-by-default tool section we
    # don't surface; empty keeps it tidy without breaking the panel.
    return {"skills": []}


@router.get("/api/skills/builtin/{name}")
async def builtin_skill(name: str):
    return JSONResponse(status_code=404, content={"detail": "no builtin detail"})


@router.get("/api/skills/{name}/markdown")
async def skill_markdown(name: str):
    md = await _markdown_for(name)
    if md is None:
        return JSONResponse(status_code=404, content={"detail": "no such skill"})
    return {"markdown": md, "text": md}


@router.delete("/api/skills/{name}")
async def delete_skill(name: str):
    return JSONResponse(status_code=501,
                        content={"detail": "deleting skills not supported here"})
