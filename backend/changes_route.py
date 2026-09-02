"""HTTP surface for per-turn change review (backend/changes.py)."""
from __future__ import annotations

import asyncio
import os

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from . import changes, sessions_store

router = APIRouter()


def _sk(session: str) -> str:
    return sessions_store.session_key_for((session or "").strip())


@router.get("/api/changes/turn")
async def changes_turn(session: str = "", turn: int = 0):
    rec = await asyncio.to_thread(changes.turn_record, _sk(session), int(turn))
    if not rec:
        return JSONResponse(status_code=404, content={"ok": False, "reason": "not_found"})
    return {"ok": True, "record": rec}


@router.get("/api/changes/session")
async def changes_session(session: str = ""):
    turns = await asyncio.to_thread(changes.session_turns, _sk(session))
    return {"ok": True, "turns": turns}


@router.get("/api/changes/diff")
async def changes_diff(session: str = "", turn: int = 0, path: str = ""):
    d = await asyncio.to_thread(changes.diff_for, _sk(session), int(turn), path)
    return {"ok": True, **d}


@router.post("/api/changes/revert")
async def changes_revert(payload: dict = Body(default=None)):
    p = payload or {}
    try:
        turn = int(p.get("turn") or 0)
    except (TypeError, ValueError):
        return JSONResponse(status_code=422, content={"ok": False, "reason": "turn must be an integer"})
    ok, reason = await asyncio.to_thread(changes.revert, _sk(str(p.get("session") or "")),
                                         turn, str(p.get("path") or ""))
    if ok:
        return {"ok": True}
    status = 404 if reason == "not_found" else 409
    return JSONResponse(status_code=status, content={"ok": False, "reason": reason})


def _nested(inner: str, outer: str) -> bool:
    """True when `inner` sits under `outer` (both normalized absolute paths)."""
    return inner.startswith(outer.rstrip(os.sep) + os.sep)


@router.get("/api/changes/config")
async def changes_config_get():
    return {"ok": True, "config": changes.load_config()}


@router.put("/api/changes/config")
async def changes_config_put(payload: dict = Body(default=None)):
    p = payload or {}
    cfg = changes.load_config()
    if "roots" in p:
        roots = p["roots"]
        if not isinstance(roots, list) or not all(isinstance(r, str) and os.path.isabs(r) for r in roots):
            return JSONResponse(status_code=400, content={"ok": False, "reason": "roots must be absolute paths"})
        norm: list[str] = []
        for r in roots:
            n = os.path.normpath(r)
            if n == os.sep:
                return JSONResponse(status_code=400, content={
                    "ok": False, "reason": "/ cannot be watched"})
            if n in norm:
                continue                      # duplicate, silently collapse
            for other in norm:
                if _nested(n, other) or _nested(other, n):
                    return JSONResponse(status_code=400, content={
                        "ok": False, "reason": f"{n} overlaps {other}; every change would be listed twice"})
            norm.append(n)
        cfg["roots"] = norm
    for key in ("prune_dirs", "skip_ext"):
        if key in p:
            v = p[key]
            if not isinstance(v, list) or not all(isinstance(x, str) and x for x in v):
                return JSONResponse(status_code=400, content={"ok": False, "reason": f"{key} must be a list of strings"})
            cfg[key] = v
    if "max_bytes" in p:
        try:
            mb = int(p["max_bytes"])
        except (TypeError, ValueError):
            mb = -1
        if not (1024 <= mb <= 4 * 1024 * 1024):
            return JSONResponse(status_code=400, content={"ok": False, "reason": "max_bytes must be 1 KB to 4 MB"})
        cfg["max_bytes"] = mb
    changes.save_config(cfg)
    return {"ok": True, "config": cfg}


@router.post("/api/changes/rebuild")
async def changes_rebuild():
    # rebuild() itself owns the re-entrancy check (a check here would race two
    # concurrent POSTs into two full rebuilds); it reports back with busy.
    out = await asyncio.to_thread(changes.rebuild)
    if out.get("busy"):
        return JSONResponse(status_code=409, content={"ok": False, "reason": "rebuild_running"})
    return {"ok": True, **out}


@router.get("/api/changes/stats")
async def changes_stats():
    return {"ok": True, **(await asyncio.to_thread(changes.stats))}
