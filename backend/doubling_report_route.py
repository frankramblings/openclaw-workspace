"""Client-side doubling reports — the missing half of the frame tracer.

Bug B (2026-09-11): a reply rendered twice in the LIVE bubble while
`/api/history` for the same thread was clean and a reload cured it. The backend
tracer (`bridge._trace_chat`) ran for 29 minutes and exonerated the relay: of
6233 frames, every real chat frame was an ordinary `startswith=true` delta and
the redelivery branch never fired. The frames the SPA reducer actually applied,
and the bubble text they produced, were never recorded anywhere — so the next
occurrence would have been just as undiagnosable as the last.

The SPA now runs `findDoubledSpan()` over each finished bubble and POSTs its
turn frame log here only when a bubble really did double. Clean turns post
nothing, so this endpoint is silent in normal operation and needs no flag file.

Reports land in `.data/spa-doubling.jsonl`, newest last, size-capped so a
pathological client can't fill the disk.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

router = APIRouter()

_REPORT_PATH = Path(__file__).resolve().parent.parent / ".data" / "spa-doubling.jsonl"
# A report carries one turn's frame log; a few hundred KB each at worst.
_MAX_BYTES = 8 * 1024 * 1024
# Guard against a client shipping an unbounded thread as one "report".
_MAX_FRAMES = 1000
_MAX_TEXT = 20000


def _clip(value, limit):
    text = "" if value is None else str(value)
    return text[:limit]


@router.post("/api/debug/doubling")
async def report_doubling(request: Request):
    """Record one client-detected doubled bubble. Always returns 200: this is a
    diagnostic sink, and a failure here must never surface as an error in a
    chat that otherwise completed fine."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 - malformed body is a no-op, not a 500
        return JSONResponse({"ok": False, "reason": "unparseable"})
    if not isinstance(body, dict):
        return JSONResponse({"ok": False, "reason": "not-an-object"})

    frames = body.get("frames")
    frames = frames[:_MAX_FRAMES] if isinstance(frames, list) else []
    record = {
        "t": time.time(),
        "session": _clip(body.get("session"), 200),
        "turn_id": _clip(body.get("turn_id"), 200),
        "span": _clip((body.get("detected") or {}).get("span")
                      if isinstance(body.get("detected"), dict) else None, 500),
        "count": (body.get("detected") or {}).get("count")
                 if isinstance(body.get("detected"), dict) else None,
        "text": _clip(body.get("text"), _MAX_TEXT),
        "frames": frames,
    }

    try:
        _REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
        # Truncate rather than rotate: these are disposable diagnostics, and a
        # full file means the oldest reports already did their job.
        if _REPORT_PATH.exists() and _REPORT_PATH.stat().st_size > _MAX_BYTES:
            _REPORT_PATH.unlink()
        with _REPORT_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except OSError:
        return JSONResponse({"ok": False, "reason": "write-failed"})
    return JSONResponse({"ok": True})
