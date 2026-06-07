"""Skills: the Odysseus skills panel, backed by OpenClaw's real skill registry.

The gateway's `skills.status` returns the agent's full skill set (~60 entries)
with name/description/source/filePath/emoji/disabled/eligible/... We map that
onto the shape the skills.js panel renders, and serve each skill's SKILL.md
from its on-disk `filePath` for the expand-to-read view.

Read-only except enable/disable (gateway skills.update); list + view markdown.
The panel's audit/add actions still ack cleanly without mutating.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from .bridge import gateway_call

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
        "enabled": not s.get("disabled"),
        "tags": tags,
        "uses": 0,
    }


async def fetch_skills() -> list[dict]:
    """Pull skills.status from the gateway, refresh the filePath cache, map them."""
    payload = await gateway_call("skills.status")
    raw = payload.get("skills") or []
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


@router.post("/api/skills/{name}/enabled")
async def set_skill_enabled(name: str, body: dict = Body(default=None)):
    """Enable/disable one skill via the gateway. Verified: skills.update
    {skillKey, enabled} -> {ok, skillKey, config}. The overlay toggle posts
    {"enabled": bool}; `name` is the display name (resolved to skillKey via
    the cache) or already a skillKey."""
    enabled = bool((body or {}).get("enabled", True))
    entry = _by_name.get(name)
    if entry is None:
        try:
            await fetch_skills()  # refresh the name -> entry cache
        except Exception:  # noqa: BLE001
            pass
        entry = _by_name.get(name)
    if entry is None and _by_name and not any(
            (s or {}).get("skillKey") == name for s in _by_name.values()):
        return JSONResponse(status_code=404,
                            content={"ok": False,
                                     "error": f"unknown skill: {name!r}"})
    skill_key = (entry or {}).get("skillKey") or name
    try:
        payload = await gateway_call("skills.update",
                                     {"skillKey": skill_key, "enabled": enabled})
        return {"ok": True, "skillKey": skill_key, "enabled": enabled,
                "config": payload.get("config")}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": f"{exc!r}"})


@router.delete("/api/skills/{name}")
async def delete_skill(name: str):
    return JSONResponse(status_code=501,
                        content={"detail": "deleting skills not supported here"})
