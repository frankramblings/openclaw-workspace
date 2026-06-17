"""Calendar router — dispatches to the configured provider (google | caldav).
Endpoints, payloads, and responses are identical across providers.

Provider-dispatched (CRUD):
  GET  /api/calendar/calendars
  GET  /api/calendar/events
  POST /api/calendar/events
  PUT  /api/calendar/events/{uid}
  DELETE /api/calendar/events/{uid}

Google/brain-specific (always google path or stub):
  POST /api/calendar/quick-parse   — NL→event via brain
  POST /api/calendar/sync          — stub (we fetch live)
  POST /api/calendar/import        — ICS import (uses active provider's create_event)
"""
from __future__ import annotations

import re

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from . import calendar_caldav, calendar_config, calendar_google

router = APIRouter()


def _provider():
    return calendar_caldav if calendar_config.provider() == "caldav" else calendar_google


# --- provider-dispatched CRUD ------------------------------------------------

@router.get("/api/calendar/calendars")
async def calendars():
    try:
        return {"calendars": await _provider().list_calendars()}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"calendars": [], "error": f"{exc!r}"})


@router.get("/api/calendar/events")
async def events(start: str = "", end: str = ""):
    try:
        return {"events": await _provider().list_events(start, end)}
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"events": [], "error": f"{exc!r}"})


@router.post("/api/calendar/events")
async def create_event(payload: dict = Body(...)):
    try:
        return await _provider().create_event(payload)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"error": f"{exc!r}"})


@router.put("/api/calendar/events/{uid}")
async def update_event(uid: str, payload: dict = Body(...)):
    try:
        return await _provider().update_event(uid, payload)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"error": f"{exc!r}"})


@router.delete("/api/calendar/events/{uid}")
async def delete_event(uid: str, request: Request):
    # Bug 2 fix: pass raw param (may be None/empty); each provider applies its
    # own default. Do NOT hardcode "primary" here — that would break CalDAV.
    cal = request.query_params.get("calendar") or None
    try:
        return await _provider().delete_event(uid, cal)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"{exc!r}"})


# --- google/brain-specific ---------------------------------------------------

@router.post("/api/calendar/quick-parse")
async def quick_parse(payload: dict = Body(default=None)):
    """NL text → event dict via the brain. Google-specific (brain-backed).
    Works regardless of provider — CalDAV provider can still parse text to create
    an event; the brain helper is a shared utility."""
    import json as _json
    payload = payload or {}
    text = payload.get("text") or ""
    tz = payload.get("tz") or "America/New_York"
    prompt = ("Convert this into a single calendar event. Output ONLY strict JSON "
              "with keys summary, dtstart, dtend, all_day, location. Use ISO-8601 "
              f"with the timezone offset for {tz}; if all_day is true use "
              f"YYYY-MM-DD dates.\n\n{text}")
    try:
        raw = await calendar_google._brain_once(prompt)
        event = _json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=503,
                            content={"error": f"quick-parse unavailable ({exc!r})"})
    return event


@router.post("/api/calendar/sync")
async def sync():
    return {"ok": True}   # we fetch live; nothing to sync


@router.post("/api/calendar/import")
async def import_ics(request: Request):
    """Import ICS data — uses the active provider's create_event so CalDAV users
    can also import .ics files."""
    body = (await request.body()).decode(errors="replace")
    imported = 0
    for block in re.split(r"BEGIN:VEVENT", body)[1:]:
        def field(key: str) -> str:
            m = re.search(rf"^{key}[^:\r\n]*:(.+)$", block, re.M)
            return m.group(1).strip() if m else ""
        dts = field("DTSTART")
        if not dts:
            continue
        all_day = "VALUE=DATE" in block or len(dts) == 8
        dte = field("DTEND")
        try:
            await _provider().create_event({
                "summary": field("SUMMARY"), "all_day": all_day,
                "dtstart": calendar_google._ics_iso(dts),
                "dtend": calendar_google._ics_iso(dte) if dte else calendar_google._ics_iso(dts),
                "calendar": "primary" if calendar_config.provider() == "google" else "",
            })
            imported += 1
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "imported": imported}
