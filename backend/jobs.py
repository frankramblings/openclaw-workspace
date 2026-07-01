"""Live Jobs API — reads the bin/job registry and streams progress to the SPA.

Layer 2 of the Live Jobs design (docs/superpowers/specs/2026-06-30-workspace-live-jobs-design.md).

The registry is a directory of atomic JSON files written by `bin/job`
(`$WORKSPACE/tmp/jobs/<id>.json`). This router only READS them — it never
writes, so it stays fully decoupled from producers.

  GET /api/jobs          -> {"jobs": [ …records… ]}  (running first, newest first)
  GET /api/jobs/stream   -> text/event-stream; snapshot on connect, then a framed
                            record list whenever the on-disk set changes.

Fail-soft everywhere: a malformed/partial file is skipped, never fatal.
"""

from __future__ import annotations

import asyncio
import json
import time
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse, StreamingResponse

from .vault_store import WORKSPACE

router = APIRouter()

JOBS_DIR = WORKSPACE / "tmp" / "jobs"

POLL_SECS = 0.4           # registry poll interval for the SSE stream
STALL_SECS = 30           # running jobs with no update in this long are "stalled"
RETAIN_SECS = 60          # terminal jobs older than this are dropped from output

# Internal bookkeeping fields we don't leak to the client.
_PRIVATE = ("_updatedEpoch", "_pctExplicit")


def _read_all() -> list[dict]:
    """All current job records, cleaned + sorted (running first, newest first).

    Skips unparseable files and drops terminal records past the retain window so
    the stream self-heals even if bin/job's sweep hasn't run.
    """
    if not JOBS_DIR.is_dir():
        return []
    now = time.time()
    recs: list[dict] = []
    for p in JOBS_DIR.glob("*.json"):
        try:
            rec = json.loads(p.read_text())
        except Exception:
            continue  # partial write mid-replace or garbage — skip, never crash
        if not isinstance(rec, dict) or "id" not in rec:
            continue
        updated = rec.get("_updatedEpoch") or 0
        status = rec.get("status")
        if status in ("done", "failed") and now - updated > RETAIN_SECS:
            continue
        # derive a "stalled" hint for running jobs gone quiet (writer owns real state)
        if status == "running" and updated and now - updated > STALL_SECS:
            rec["stalled"] = int(now - updated)
        for k in _PRIVATE:
            rec.pop(k, None)
        recs.append(rec)

    order = {"running": 0, "failed": 1, "done": 2}
    recs.sort(key=lambda r: (order.get(r.get("status"), 3),
                             _neg(r.get("startedAt", ""))))
    return recs


def _neg(s: str):
    # sort strings descending by negating their sort position via reverse tuple
    return tuple(-ord(c) for c in s)


def _sse(obj) -> str:
    return f"data: {json.dumps(obj, separators=(',', ':'))}\n\n"


@router.get("/api/jobs")
async def jobs():
    return {"jobs": _read_all()}


@router.get("/api/jobs/stream")
async def jobs_stream():
    async def gen():
        last = None
        # emit an immediate snapshot so the client renders without waiting a tick
        snap = _read_all()
        last = json.dumps(snap, separators=(",", ":"))
        yield _sse({"jobs": snap})
        idle = 0
        while True:
            await asyncio.sleep(POLL_SECS)
            cur = _read_all()
            key = json.dumps(cur, separators=(",", ":"))
            if key != last:
                last = key
                idle = 0
                yield _sse({"jobs": cur})
            else:
                idle += 1
                # keepalive comment every ~15s so proxies don't drop an idle stream
                if idle >= int(15 / POLL_SECS):
                    idle = 0
                    yield ": keepalive\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
