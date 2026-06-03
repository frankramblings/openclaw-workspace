"""Inbox proxy: surface the existing triage-dashboard unified feed.

The triage-dashboard (OpenClaw workspace/triage-dashboard) already aggregates
gmail + slack + asana + granola/obsidian into one scored, sorted feed at
GET /api/items. We just proxy it so the Workspace backend can serve it.

NOTE (v1): Odysseus's frontend inbox view currently calls /api/email/*, not
/api/items, so wiring this into the UI is a follow-up (see the spec). The data
path is ready here regardless.
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import config

router = APIRouter()


@router.get("/api/items")
async def items(request: Request):
    """Proxy the unified triage feed, passing query params through unchanged."""
    url = f"{config.TRIAGE_URL}/api/items"
    try:
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(url, params=dict(request.query_params))
        return JSONResponse(status_code=resp.status_code, content=resp.json())
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=502,
            content={"items": [], "total": 0, "error": f"triage feed unreachable: {exc!r}"},
        )
