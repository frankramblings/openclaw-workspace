"""Triage feed proxy: `/api/items` surfaces the triage-dashboard unified feed
(gmail+slack+asana+granola) for anything that wants it.

The Email tab no longer lives here — it's a real himalaya Gmail mailbox in
`email_himalaya.py`. This module is now just the thin `/api/items` proxy; the
unified triage view keeps its own home in the triage-dashboard app (:3456).
"""
from __future__ import annotations

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from .. import config

router = APIRouter()


async def _fetch_feed(params: dict | None = None) -> dict:
    """Fetch the unified triage feed. Raises on transport failure (caller maps)."""
    url = f"{config.TRIAGE_URL}/api/items"
    async with httpx.AsyncClient(timeout=40) as client:
        resp = await client.get(url, params=params or {"limit": 500})
    resp.raise_for_status()
    return resp.json()


@router.get("/api/items")
async def items(request: Request):
    """Proxy the unified triage feed, passing query params through unchanged."""
    try:
        data = await _fetch_feed(dict(request.query_params) or None)
        return JSONResponse(content=data)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(
            status_code=502,
            content={"items": [], "total": 0,
                     "error": f"triage feed unreachable: {exc!r}"})
