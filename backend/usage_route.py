"""Aggregate usage for Settings → Usage: a thin relay over the gateway's
`usage.cost` (daily tokens + estimated cost). Dollars are only trustworthy when
the gateway priced every entry; subscription (claude-cli) traffic is unpriced,
so `costed` tells the UI whether to show them at all."""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import bridge

router = APIRouter()
ALLOWED_DAYS = (7, 30)


@router.get("/api/usage/summary")
async def usage_summary(days: str = "7"):
    try:
        n = int(days)
    except (TypeError, ValueError):
        n = -1
    if n not in ALLOWED_DAYS:
        return JSONResponse(status_code=400, content={"ok": False, "reason": "bad_days"})
    try:
        payload = await bridge.gateway_call("usage.cost", {"days": n}, timeout=20.0)
    except Exception as exc:  # noqa: BLE001 - report the gateway failure honestly
        return JSONResponse(status_code=502, content={
            "ok": False, "reason": "gateway_error", "detail": f"{exc!r}"})
    totals = payload.get("totals") or {}
    missing = int(totals.get("missingCostEntries") or 0)
    total_tokens = int(totals.get("totalTokens") or 0)
    return {
        "ok": True,
        "days": n,
        "daily": [d for d in (payload.get("daily") or []) if isinstance(d, dict)],
        "totals": totals,
        "costed": missing == 0 and total_tokens > 0,
        "updatedAt": payload.get("updatedAt"),
    }
