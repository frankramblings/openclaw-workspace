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


def _pick(*vals):
    """First non-empty value — the gateway nests run-state under `state` in the
    rich cron.list but returns it flat (nextRunAtMs/lastRunStatus/…) in the
    compact shape, so read both."""
    for v in vals:
        if v not in (None, ""):
            return v
    return None


def _map_job(j: dict) -> dict:
    sched = j.get("schedule") or {}
    expr = sched.get("expr") or sched.get("kind") or ""
    tz = sched.get("tz") or ""
    payload = j.get("payload") or {}
    state = j.get("state") or {}
    next_at = _pick(state.get("nextWakeAtMs"), state.get("nextRunAtMs"),
                    j.get("nextRunAtMs"), j.get("nextWakeAtMs"))
    last_at = _pick(state.get("lastRunAtMs"), j.get("lastRunAtMs"))
    last_status = _pick(state.get("lastStatus"), state.get("status"),
                        j.get("lastRunStatus"), j.get("status"))
    last_error = _pick(state.get("lastError"), j.get("lastRunError"),
                       state.get("error"))
    return {
        "id": j.get("id"),
        "name": j.get("name") or j.get("id"),
        "enabled": bool(j.get("enabled")),
        "agentId": j.get("agentId"),
        "schedule": expr + (f"  ({tz})" if tz else ""),
        "schedule_expr": expr,
        "scheduleKind": j.get("scheduleKind") or sched.get("kind"),
        "tz": tz,
        "message": (payload.get("message") or "")[:280],
        "sessionTarget": j.get("sessionTarget"),
        "wakeMode": j.get("wakeMode"),
        "nextRunAtMs": next_at,
        "nextWakeAtMs": next_at,  # legacy alias
        "lastRunAtMs": last_at,
        "lastStatus": last_status,
        "lastError": ((last_error or "")[:280]) or None,
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
        data = await gateway_call("cron.list",
                                  {"limit": 200, "includeDisabled": True})
        jobs = [_map_job(j) for j in (data.get("jobs") or [])]
        # Active first, soonest next-run at the top (reads as an upcoming
        # timeline); disabled after, alphabetical.
        big = float("inf")
        jobs.sort(key=lambda j: (
            not j["enabled"],
            (j.get("nextRunAtMs") or big) if j["enabled"] else 0,
            (j["name"] or "").lower(),
        ))
        active = sum(1 for j in jobs if j["enabled"])
        attention = sum(1 for j in jobs
                        if j["enabled"] and j.get("lastStatus") == "error")
        return {"jobs": jobs, "total": data.get("total", len(jobs)),
                "summary": {"active": active,
                            "disabled": len(jobs) - active,
                            "attention": attention},
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
