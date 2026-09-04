"""Projects API (spec §5): CRUD over projects_store plus the one-time backfill."""
from __future__ import annotations

import logging

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from . import config, project_classify, project_discovery, projects_store, sessions_store

log = logging.getLogger(__name__)
router = APIRouter()


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
    from . import app as app_module  # deferred: app imports this module

    if project_classify.backfill_running():
        return {"status": "running"}
    try:
        since = int((payload or {}).get("since_days") or 90)
    except (TypeError, ValueError):
        since = 90
    # I4: seed synchronously (it's sync and cheap) before spawning the actual
    # classify pass -- a GET /api/projects right after this response already
    # shows the seeds, instead of the sidebar staying empty until backfill
    # (which can take a while) gets around to it.
    project_classify.seed_if_empty()
    app_module._spawn(project_classify.backfill(since_days=max(1, since)))
    return {"status": "started"}


@router.get("/api/projects/proposals")
async def list_proposals():
    data = project_discovery.load_proposals()
    return {"proposals": data["proposals"], "error": data.get("error"),
            "created": data.get("created") or 0, "running": project_discovery.running()}


@router.post("/api/projects/discover")
async def discover(payload: dict = Body(default=None)):
    from . import app as app_module  # deferred: app imports this module

    if project_discovery.running():
        return JSONResponse(status_code=409, content={"detail": "running"})
    try:
        since = int((payload or {}).get("since_days") or 90)
    except (TypeError, ValueError):
        since = 90
    # A rerun starts from a clean slate: the old proposal file would make
    # should_discover() false and hide a fresh result behind stale rows.
    try:
        (config.DATA_DIR / project_discovery.PROPOSAL_FILE_NAME).unlink()
    except FileNotFoundError:
        pass
    app_module._spawn(project_discovery.discover(since_days=max(1, since)))
    return {"status": "started"}


@router.post("/api/projects/proposals/{pid}/accept", status_code=201)
async def accept_proposal(pid: str):
    from . import app as app_module

    prop = project_discovery.remove_proposal(pid)
    if prop is None:
        return JSONResponse(status_code=404, content={"detail": "no such proposal"})
    try:
        rec = projects_store.create(prop["name"], hints=prop.get("hints") or [])
    except ValueError as e:
        if str(e) == "duplicate":
            return JSONResponse(status_code=409, content={"detail": "a project with that name exists"})
        return JSONResponse(status_code=400, content={"detail": "name required"})
    app_module._spawn(project_classify.backfill(since_days=90))
    return rec


@router.post("/api/projects/proposals/{pid}/dismiss")
async def dismiss_proposal(pid: str):
    if project_discovery.remove_proposal(pid) is None:
        return JSONResponse(status_code=404, content={"detail": "no such proposal"})
    return {"ok": True}
