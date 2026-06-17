"""The Odysseus Calendar tab, backed by the real Google Calendar API.

Reuses the google-calendar-mcp OAuth token (via google_auth) and talks the
Calendar REST API directly with httpx — no Node MCP middleman. Maps Google ⇄ the
iCal-ish shape calendar.js renders: dates are strings (YYYY-MM-DD for all-day,
ISO datetime for timed). quick-parse routes to the OpenClaw brain.
"""
from __future__ import annotations

import asyncio
import json as _json
import re
import urllib.parse

import httpx
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from . import bridge, config, google_auth

router = APIRouter()
_API = "https://www.googleapis.com/calendar/v3"
_DEFAULT_COLOR = "#4285f4"


# --- low-level Google API helpers --------------------------------------------

def _auth() -> dict:
    return {"Authorization": f"Bearer {google_auth.access_token()}"}


def _cal_path(cal_id: str) -> str:
    return urllib.parse.quote(cal_id or "primary", safe="")


# One shared client: each request used to pay a fresh TCP+TLS handshake, and
# the events view fans out to every visible calendar (~8 calls per view).
_client: httpx.AsyncClient | None = None


def _http() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        # Bound the keep-alive pool and expire idle connections quickly so
        # Google-closed keep-alives don't pile up in CLOSE_WAIT and leak fds.
        _client = httpx.AsyncClient(
            timeout=30,
            limits=httpx.Limits(max_keepalive_connections=5, keepalive_expiry=30),
        )
    return _client


async def _headers() -> dict:
    # access_token() does a sync httpx POST on refresh — keep it off the loop.
    return await asyncio.to_thread(_auth)


async def _get(path: str, params: dict | None = None) -> dict:
    r = await _http().get(f"{_API}{path}", headers=await _headers(),
                          params=params or {})
    r.raise_for_status()
    return r.json()


async def _post(path: str, body: dict) -> dict:
    r = await _http().post(f"{_API}{path}", json=body, headers=await _headers())
    r.raise_for_status()
    return r.json()


# --- pure mappers (unit-tested) ----------------------------------------------

def map_calendar(c: dict) -> dict:
    bg = c.get("backgroundColor") or _DEFAULT_COLOR
    return {"href": c.get("id"), "name": c.get("summary") or c.get("id"),
            "color": bg, "hex": bg, "primary": bool(c.get("primary"))}


def map_event(e: dict, cal_id: str, color: str) -> dict:
    start, end = e.get("start") or {}, e.get("end") or {}
    return {
        "uid": e.get("id"),
        "summary": e.get("summary") or "(no title)",
        "dtstart": start.get("date") or start.get("dateTime") or "",
        "dtend": end.get("date") or end.get("dateTime") or "",
        "all_day": "date" in start,
        "location": e.get("location") or "",
        "description": e.get("description") or "",
        "color": color,
        "event_type": "default",
        "calendar": cal_id,
    }


def to_google_event(d: dict) -> dict:
    g = {"summary": d.get("summary") or "",
         "location": d.get("location") or "",
         "description": d.get("description") or ""}
    if d.get("all_day"):
        g["start"] = {"date": d.get("dtstart")}
        g["end"] = {"date": d.get("dtend") or d.get("dtstart")}
    else:
        g["start"] = {"dateTime": d.get("dtstart")}
        g["end"] = {"dateTime": d.get("dtend") or d.get("dtstart")}
    return g


def _to_rfc3339(day: str, is_end: bool) -> str:
    """Frontend sends YYYY-MM-DD; widen to a full-day RFC3339 instant."""
    day = (day or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        return f"{day}T23:59:59Z" if is_end else f"{day}T00:00:00Z"
    return day  # already ISO / empty → pass through


# --- calendars ---------------------------------------------------------------

@router.get("/api/calendar/calendars")
async def calendars():
    try:
        data = await _get("/users/me/calendarList")
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"calendars": [],
                             "error": f"calendar auth/list failed: {exc!r}"})
    return {"calendars": [map_calendar(c) for c in data.get("items", [])]}


# --- events (read, across calendars) -----------------------------------------

async def _events_for(cal_id: str, color: str, time_min: str, time_max: str) -> list[dict]:
    try:
        data = await _get(f"/calendars/{_cal_path(cal_id)}/events",
                          {"timeMin": time_min, "timeMax": time_max,
                           "singleEvents": "true", "orderBy": "startTime",
                           "maxResults": 2500})
    except Exception:  # noqa: BLE001
        return []
    return [map_event(e, cal_id, color) for e in data.get("items", [])]


@router.get("/api/calendar/events")
async def events(start: str = "", end: str = ""):
    time_min, time_max = _to_rfc3339(start, False), _to_rfc3339(end, True)
    try:
        cal_data = await _get("/users/me/calendarList")
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"events": [], "error": f"{exc!r}"})
    cals = [(c["id"], c.get("backgroundColor") or _DEFAULT_COLOR)
            for c in cal_data.get("items", []) if not c.get("hidden")]
    results = await asyncio.gather(
        *[_events_for(cid, color, time_min, time_max) for cid, color in cals])
    return {"events": [e for sub in results for e in sub]}


# --- create / update / delete ------------------------------------------------

@router.post("/api/calendar/events")
async def create_event(payload: dict = Body(...)):
    cal = payload.get("calendar") or "primary"
    try:
        g = await _post(f"/calendars/{_cal_path(cal)}/events", to_google_event(payload))
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"error": f"{exc!r}"})
    return map_event(g, cal, payload.get("color") or _DEFAULT_COLOR)


@router.put("/api/calendar/events/{uid}")
async def update_event(uid: str, payload: dict = Body(...)):
    cal = payload.get("calendar") or "primary"
    url = f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}"
    r = await _http().patch(url, json=to_google_event(payload),
                            headers=await _headers())
    if r.status_code >= 300:
        return JSONResponse(status_code=502, content={"error": r.text[:300]})
    return map_event(r.json(), cal, payload.get("color") or _DEFAULT_COLOR)


@router.delete("/api/calendar/events/{uid}")
async def delete_event(uid: str, request: Request):
    cal = request.query_params.get("calendar") or "primary"
    url = f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}"
    r = await _http().delete(url, headers=await _headers())
    if r.status_code not in (200, 204):
        return JSONResponse(status_code=502, content={"ok": False, "error": r.text[:300]})
    return {"ok": True, "deleted": [uid]}


# --- quick-parse (brain) -----------------------------------------------------

async def _brain_once(prompt: str) -> str:
    chunks: list[str] = []
    async for sse in bridge.stream_turn(prompt, session_key=config.web_session_key()):
        if not sse.startswith("data:"):
            continue
        line = sse[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            o = _json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(o, dict) and o.get("delta"):
            chunks.append(o["delta"])
    return "".join(chunks).strip()


@router.post("/api/calendar/quick-parse")
async def quick_parse(payload: dict = Body(default=None)):
    payload = payload or {}
    text = payload.get("text") or ""
    tz = payload.get("tz") or "America/New_York"
    prompt = ("Convert this into a single calendar event. Output ONLY strict JSON "
              "with keys summary, dtstart, dtend, all_day, location. Use ISO-8601 "
              f"with the timezone offset for {tz}; if all_day is true use "
              f"YYYY-MM-DD dates.\n\n{text}")
    try:
        raw = await _brain_once(prompt)
        event = _json.loads(raw[raw.find("{"): raw.rfind("}") + 1])
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=503,
                            content={"error": f"quick-parse unavailable ({exc!r})"})
    return event


# --- ICS import + sync stub --------------------------------------------------

@router.post("/api/calendar/sync")
async def sync():
    return {"ok": True}   # we fetch live; nothing to sync


def _ics_iso(v: str) -> str:
    v = v.strip()
    if len(v) == 8:                       # 20260704 -> 2026-07-04
        return f"{v[:4]}-{v[4:6]}-{v[6:8]}"
    if "T" in v:                          # 20260704T130000Z -> ISO
        return f"{v[:4]}-{v[4:6]}-{v[6:8]}T{v[9:11]}:{v[11:13]}:{v[13:15]}Z"
    return v


@router.post("/api/calendar/import")
async def import_ics(request: Request):
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
            await _post("/calendars/primary/events", to_google_event({
                "summary": field("SUMMARY"), "all_day": all_day,
                "dtstart": _ics_iso(dts),
                "dtend": _ics_iso(dte) if dte else _ics_iso(dts)}))
            imported += 1
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "imported": imported}
