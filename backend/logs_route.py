"""Gateway log tail relay (logs.tail). The gateway already redacts secrets
from the lines it returns; the backend's secret_scrub runs on top (defense in
depth, it is cheap). Read-only, no audit."""
from __future__ import annotations

from fastapi import APIRouter

from . import gateway_admin as gw
from . import secret_scrub

router = APIRouter()

LIMIT_DEFAULT, LIMIT_MAX = 200, 2000
MAX_BYTES_DEFAULT, MAX_BYTES_MAX = 100_000, 500_000


@router.get("/api/logs/tail")
async def tail(cursor: int | None = None, limit: int = LIMIT_DEFAULT, max_bytes: int = MAX_BYTES_DEFAULT):
    if not 1 <= limit <= LIMIT_MAX:
        return gw.fail(400, "bad_request", f"limit must be 1..{LIMIT_MAX}")
    if not 1 <= max_bytes <= MAX_BYTES_MAX:
        return gw.fail(400, "bad_request", f"max_bytes must be 1..{MAX_BYTES_MAX}")
    if cursor is not None and cursor < 0:
        return gw.fail(400, "bad_request", "cursor must be >= 0")
    try:
        payload = await gw.logs_tail(cursor, limit, max_bytes)
    except Exception as exc:  # noqa: BLE001
        return gw.error_response(exc)
    lines = [secret_scrub.scrub(str(line))[0] for line in (payload.get("lines") or [])]
    return {"ok": True, "file": payload.get("file"), "cursor": payload.get("cursor"),
            "size": payload.get("size"), "lines": lines,
            "truncated": bool(payload.get("truncated")), "reset": bool(payload.get("reset"))}
