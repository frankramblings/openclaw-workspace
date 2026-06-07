"""Cron: a scheduled-jobs view backed by the gateway's cron.* API.

OpenClaw runs scheduled agent turns (the heartbeat, refresh jobs, briefs…) via
its cron system. `cron.list` returns the jobs; `cron.run` fires one now;
`cron.update` toggles enabled. The Odysseus SPA has no cron tab, so this pairs
with a self-contained overlay (frontend-overrides/js/cron.js) that adds one.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from .bridge import gateway_call


router = APIRouter()


def _map_job(j: dict) -> dict:
    sched = j.get("schedule") or {}
    expr = sched.get("expr") or sched.get("kind") or ""
    tz = sched.get("tz") or ""
    payload = j.get("payload") or {}
    state = j.get("state") or {}
    return {
        "id": j.get("id"),
        "name": j.get("name") or j.get("id"),
        "enabled": bool(j.get("enabled")),
        "agentId": j.get("agentId"),
        "schedule": expr + (f"  ({tz})" if tz else ""),
        "schedule_expr": expr,
        "tz": tz,
        "message": (payload.get("message") or "")[:280],
        "sessionTarget": j.get("sessionTarget"),
        "wakeMode": j.get("wakeMode"),
        "nextWakeAtMs": state.get("nextWakeAtMs") or j.get("nextWakeAtMs"),
        "lastRunAtMs": state.get("lastRunAtMs"),
        "lastStatus": state.get("lastStatus") or state.get("status"),
        "createdAtMs": j.get("createdAtMs"),
        "updatedAtMs": j.get("updatedAtMs"),
    }


def _map_run(r: dict) -> dict:
    """One cron.runs entry → the UI's history-row shape. Verified entry shape:
    {ts, jobId, status: ok|error|skipped, error?, summary?, durationMs?,
    runAtMs?, delivered?, ...} (gateway protocol/schema/cron.ts)."""
    return {
        "ts": r.get("runAtMs") or r.get("ts"),
        "status": r.get("status") or "ok",
        "durationMs": r.get("durationMs"),
        "summary": (r.get("summary") or "")[:500],
        "error": (r.get("error") or "")[:500],
        "delivered": r.get("delivered"),
    }


def _runs_list(payload) -> list:
    """cron.runs' container key isn't pinned down across gateway versions —
    accept the obvious candidates and a bare list."""
    if isinstance(payload, list):
        return payload
    for key in ("entries", "runs", "logs", "items"):
        val = payload.get(key)
        if isinstance(val, list):
            return val
    return []


@router.get("/api/cron")
async def list_cron():
    try:
        data = await gateway_call("cron.list", {"limit": 200})
        jobs = [_map_job(j) for j in (data.get("jobs") or [])]
        # Enabled first, then by name — stable, scannable.
        jobs.sort(key=lambda j: (not j["enabled"], (j["name"] or "").lower()))
        return {"jobs": jobs, "total": data.get("total", len(jobs)),
                "enabled": True}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"jobs": [], "error": f"cron unavailable: {exc!r}"})


@router.get("/api/cron/{job_id}/runs")
async def cron_runs(job_id: str, limit: int = 50):
    try:
        data = await gateway_call("cron.runs", {
            "scope": "job", "id": job_id,
            "limit": max(1, min(int(limit), 200)),
        })
        return {"runs": [_map_run(r) for r in _runs_list(data)]}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502,
                            content={"runs": [], "error": f"{exc!r}"})


@router.post("/api/cron/{job_id}/run")
async def run_cron(job_id: str):
    try:
        await gateway_call("cron.run", {"id": job_id})
        return {"ok": True, "id": job_id}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"{exc!r}"})


@router.post("/api/cron/{job_id}/enable")
async def enable_cron(job_id: str):
    try:
        await gateway_call("cron.update", {"id": job_id, "enabled": True})
        return {"ok": True, "id": job_id, "enabled": True}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"{exc!r}"})


@router.post("/api/cron/{job_id}/disable")
async def disable_cron(job_id: str):
    try:
        await gateway_call("cron.update", {"id": job_id, "enabled": False})
        return {"ok": True, "id": job_id, "enabled": False}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"{exc!r}"})
