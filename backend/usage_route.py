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


def _int(v) -> int:
    """Best-effort int coercion for gateway-supplied fields: a malformed
    payload (wrong type, garbage string) degrades to 0 rather than raising."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return int(v)
    return 0


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
    raw_totals = payload.get("totals")
    totals = raw_totals if isinstance(raw_totals, dict) else {}
    raw_daily = payload.get("daily")
    daily = [d for d in raw_daily if isinstance(d, dict)] if isinstance(raw_daily, list) else []
    missing = _int(totals.get("missingCostEntries"))
    total_tokens = _int(totals.get("totalTokens"))
    # The gateway's own ledger cache can be mid-refresh (cacheStatus
    # refreshing/partial/stale), in which case these numbers are incomplete and
    # the UI must not claim otherwise.
    raw_cache_status = payload.get("cacheStatus")
    cache_status = (raw_cache_status.get("status")
                    if isinstance(raw_cache_status, dict) else None)
    return {
        "ok": True,
        "days": n,
        "daily": daily,
        "totals": totals,
        "fresh": cache_status in (None, "fresh"),
        "costed": missing == 0 and total_tokens > 0,
        "updatedAt": payload.get("updatedAt"),
    }
