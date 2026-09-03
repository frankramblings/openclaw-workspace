"""Projects API (spec §5): CRUD over projects_store plus the one-time backfill."""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from . import project_classify, projects_store, sessions_store

log = logging.getLogger(__name__)
router = APIRouter()
_BG: set[asyncio.Task] = set()


def _spawn(coro) -> asyncio.Task:
    task = asyncio.create_task(coro)
    _BG.add(task)
    task.add_done_callback(_BG.discard)
    return task


@router.get("/api/projects")
async def list_projects():
    return projects_store.list_projects()


@router.post("/api/projects", status_code=201)
async def create_project(payload: dict = Body(default=None)):
    name = str((payload or {}).get("name") or "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"detail": "name required"})
    try:
        return projects_store.create(name)
    except ValueError as e:
        if str(e) == "duplicate":
            return JSONResponse(status_code=409, content={"detail": "a project with that name exists"})
        return JSONResponse(status_code=400, content={"detail": "name required"})


@router.patch("/api/projects/{pid}")
async def patch_project(pid: str, payload: dict = Body(default=None)):
    payload = payload or {}
    fields = {}
    if "name" in payload:
        fields["name"] = str(payload.get("name") or "")
    if "archived" in payload:
        fields["archived"] = bool(payload.get("archived"))
    try:
        rec = projects_store.update(pid, **fields)
    except ValueError as e:
        if str(e) == "duplicate":
            return JSONResponse(status_code=409, content={"detail": "a project with that name exists"})
        return JSONResponse(status_code=400, content={"detail": "name required"})
    if rec is None:
        return JSONResponse(status_code=404, content={"detail": "no such project"})
    return rec


@router.delete("/api/projects/{pid}")
async def delete_project(pid: str):
    if projects_store.get(pid) is None:
        return JSONResponse(status_code=404, content={"detail": "no such project"})
    unfiled = sessions_store.unfile_project(pid)
    projects_store.delete(pid)
    return {"ok": True, "unfiled": unfiled}


@router.post("/api/projects/backfill")
async def backfill(payload: dict = Body(default=None)):
    if project_classify.backfill_running():
        return {"status": "running"}
    try:
        since = int((payload or {}).get("since_days") or 90)
    except (TypeError, ValueError):
        since = 90
    _spawn(project_classify.backfill(since_days=max(1, since)))
    return {"status": "started"}
