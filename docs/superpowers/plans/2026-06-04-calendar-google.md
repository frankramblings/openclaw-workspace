# Google Calendar tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the Odysseus Calendar tab a real Google Calendar client, reusing the existing `google-calendar-mcp` OAuth token via the Calendar REST API.

**Architecture:** `google_auth.py` refreshes + caches a bearer token from the reused creds; `calendar_google.py` (FastAPI router) calls the Calendar API with `httpx`, maps Google ⇄ the iCal-ish shape `calendar.js` expects, and routes quick-parse to the brain bridge. Pure mappers unit-tested; live verified against the real account (reads on the week, writes on a self-cleaning `[workspace test]` event).

**Tech Stack:** Python 3.14, FastAPI, httpx, the OpenClaw brain bridge (quick-parse). No google client libs — plain REST.

**Spec:** `docs/superpowers/specs/2026-06-04-calendar-google-design.md`

---

## File Structure

- Create `backend/google_auth.py` — read client keys (`~/.gmail-mcp/gcp-oauth.keys.json`) + refresh token (`~/.config/google-calendar-mcp/tokens.json`), POST to Google's token endpoint, cache the access token until ~60s before expiry. One job: hand out a valid bearer token.
- Create `backend/calendar_google.py` — the `/api/calendar/*` router + pure mappers (Google event ⇄ frontend event, calendar mapping) + quick-parse via the brain.
- Create `backend/tests/test_calendar_google.py` — pytest for the pure mappers.
- Modify `backend/app.py` — include the calendar router.

Config paths are read-only; nothing secret enters the repo.

---

## Task 1: Probe — confirm token refresh + capture Google event JSON + frontend params

**Files:** none (scratch probe).

- [ ] **Step 1: Confirm refresh + calendarList (already verified once; re-confirm)**

```bash
cd ~/openclaw-workspace
.venv/bin/python - <<'PY'
import json, httpx
keys=json.load(open('~/.gmail-mcp/gcp-oauth.keys.json'))['installed']
tok=json.load(open('~/.config/google-calendar-mcp/tokens.json'))
acct=tok.get('normal') or next(iter(tok.values()))
c=httpx.Client(timeout=25)
at=c.post('https://oauth2.googleapis.com/token',data={'client_id':keys['client_id'],'client_secret':keys['client_secret'],'refresh_token':acct['refresh_token'],'grant_type':'refresh_token'}).json()['access_token']
# one event from primary this month — capture the JSON shape
import datetime
ev=c.get('https://www.googleapis.com/calendar/v3/calendars/primary/events',params={'maxResults':3,'singleEvents':'true','orderBy':'startTime','timeMin':'2026-06-01T00:00:00Z'},headers={'Authorization':f'Bearer {at}'}).json()
print(json.dumps(ev.get('items',[{}])[0],indent=1)[:1200])
PY
```
Expected: a real event JSON. **Record** the field names: `id`, `summary`, `location`,
`description`, `start.{date,dateTime,timeZone}`, `end.{…}`, `colorId`, `status`,
`recurringEventId`. The mappers in Tasks 3-4 reconcile against this.

- [ ] **Step 2: Check what `start`/`end` the frontend sends**

Read `frontend/js/calendar.js` around line 110-160; note whether `start`/`end`
are `YYYY-MM-DD` or ISO. (Used to build `timeMin`/`timeMax`.) Record it.

---

## Task 2: Token helper `google_auth.py`

**Files:** Create `backend/google_auth.py`, `backend/tests/test_calendar_google.py`

- [ ] **Step 1: Failing test for the cache logic (pure part)**

```python
# backend/tests/test_calendar_google.py
from backend import google_auth

def test_token_cache_expiry_logic(monkeypatch):
    calls = {"n": 0}
    def fake_fetch():
        calls["n"] += 1
        return ("tok%d" % calls["n"], 1000.0 + calls["n"])  # (token, expires_at)
    monkeypatch.setattr(google_auth, "_fetch_token", fake_fetch)
    google_auth._CACHE["token"] = None; google_auth._CACHE["exp"] = 0.0
    monkeypatch.setattr(google_auth.time, "time", lambda: 100.0)
    assert google_auth.access_token() == "tok1"     # first fetch
    assert google_auth.access_token() == "tok1"     # cached (not expired)
    assert calls["n"] == 1
    monkeypatch.setattr(google_auth.time, "time", lambda: 2000.0)
    assert google_auth.access_token() == "tok2"     # expired → refetch
    assert calls["n"] == 2
```

- [ ] **Step 2: Run → FAIL.** `.venv/bin/python -m pytest backend/tests/test_calendar_google.py -q`

- [ ] **Step 3: Implement**

```python
"""Google OAuth bearer-token helper, reusing the google-calendar-mcp credentials.
Read-only on the creds; refreshes + caches an access token in memory."""
from __future__ import annotations
import json, os, time
from pathlib import Path
import httpx

_KEYS = Path(os.environ.get("GOOGLE_OAUTH_KEYS",
             Path.home() / ".gmail-mcp" / "gcp-oauth.keys.json"))
_TOKENS = Path(os.environ.get("GOOGLE_CAL_TOKENS",
             Path.home() / ".config" / "google-calendar-mcp" / "tokens.json"))
_TOKEN_URL = "https://oauth2.googleapis.com/token"
_CACHE: dict = {"token": None, "exp": 0.0}


def _creds() -> tuple[str, str, str]:
    keys = json.loads(_KEYS.read_text())
    inst = keys.get("installed") or keys.get("web") or {}
    tok = json.loads(_TOKENS.read_text())
    acct = tok.get("normal") or next(iter(tok.values()))
    return inst["client_id"], inst["client_secret"], acct["refresh_token"]


def _fetch_token() -> tuple[str, float]:
    cid, secret, refresh = _creds()
    with httpx.Client(timeout=25) as c:
        r = c.post(_TOKEN_URL, data={"client_id": cid, "client_secret": secret,
                                     "refresh_token": refresh, "grant_type": "refresh_token"})
    r.raise_for_status()
    d = r.json()
    return d["access_token"], time.time() + int(d.get("expires_in", 3600))


def access_token() -> str:
    if _CACHE["token"] and time.time() < _CACHE["exp"] - 60:
        return _CACHE["token"]
    tok, exp = _fetch_token()
    _CACHE["token"], _CACHE["exp"] = tok, exp
    return tok
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Commit.** `git add backend/google_auth.py backend/tests/test_calendar_google.py && git commit -m "feat(calendar): google_auth token helper (reuse google-calendar-mcp creds)"`

---

## Task 3: Calendars — `GET /api/calendar/calendars`

**Files:** Create `backend/calendar_google.py`; Modify `backend/app.py`; test file.

- [ ] **Step 1: Failing test for the calendar mapper**

```python
from backend.calendar_google import map_calendar

def test_map_calendar():
    c = map_calendar({"id": "you@example.com", "summary": "Frank",
                      "backgroundColor": "#44a703", "primary": True})
    assert c["href"] == "you@example.com"
    assert c["name"] == "Frank"
    assert c["color"] == "#44a703" and c["hex"] == "#44a703"
    assert c["primary"] is True
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement helper + GET + httpx wrapper**

```python
"""The Odysseus Calendar tab, backed by the real Google Calendar API (reusing the
google-calendar-mcp OAuth token via google_auth)."""
from __future__ import annotations
import httpx
from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse
from . import google_auth

router = APIRouter()
_API = "https://www.googleapis.com/calendar/v3"


async def _get(path: str, params: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{_API}{path}",
                        headers={"Authorization": f"Bearer {google_auth.access_token()}"},
                        params=params or {})
    r.raise_for_status()
    return r.json()


def map_calendar(c: dict) -> dict:
    bg = c.get("backgroundColor") or "#4285f4"
    return {"href": c.get("id"), "name": c.get("summary") or c.get("id"),
            "color": bg, "hex": bg, "primary": bool(c.get("primary"))}


@router.get("/api/calendar/calendars")
async def calendars():
    try:
        data = await _get("/users/me/calendarList")
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"calendars": [], "error": f"calendar auth/list failed: {exc!r}"})
    return {"calendars": [map_calendar(c) for c in data.get("items", [])]}
```

In `app.py`: `from .calendar_google import router as calendar_router` + `app.include_router(calendar_router)`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Verify live.** Restart; `curl -s localhost:8800/api/calendar/calendars | python3 -m json.tool` → 7 calendars with names + colors.

- [ ] **Step 6: Commit.** `git commit -am "feat(calendar): list real Google calendars"`

---

## Task 4: Events — mapper + `GET /api/calendar/events?start&end` (multi-calendar)

**Files:** Modify `backend/calendar_google.py`, test file.

- [ ] **Step 1: Failing tests for the event mapper (timed + all-day)**

```python
from backend.calendar_google import map_event

def test_map_event_timed():
    e = map_event({"id": "e1", "summary": "Sync",
                   "start": {"dateTime": "2026-06-04T13:00:00-04:00"},
                   "end": {"dateTime": "2026-06-04T13:30:00-04:00"},
                   "location": "Zoom"}, cal_id="cal@x", color="#1c3eff")
    assert e["uid"] == "e1" and e["all_day"] is False
    assert e["dtstart"] == "2026-06-04T13:00:00-04:00"
    assert e["location"] == "Zoom" and e["color"] == "#1c3eff" and e["calendar"] == "cal@x"

def test_map_event_all_day():
    e = map_event({"id": "e2", "summary": "Holiday",
                   "start": {"date": "2026-07-04"}, "end": {"date": "2026-07-05"}},
                  cal_id="c", color="#e6c800")
    assert e["all_day"] is True and e["dtstart"] == "2026-07-04" and e["dtend"] == "2026-07-05"
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement mapper + concurrent multi-calendar fetch**

```python
import asyncio

def map_event(e: dict, cal_id: str, color: str) -> dict:
    start, end = e.get("start") or {}, e.get("end") or {}
    all_day = "date" in start
    return {
        "uid": e.get("id"),
        "summary": e.get("summary") or "(no title)",
        "dtstart": start.get("date") or start.get("dateTime") or "",
        "dtend": end.get("date") or end.get("dateTime") or "",
        "all_day": all_day,
        "location": e.get("location") or "",
        "description": e.get("description") or "",
        "color": color,
        "event_type": "default",
        "calendar": cal_id,
    }

async def _events_for(cal_id: str, color: str, time_min: str, time_max: str) -> list[dict]:
    try:
        data = await _get(f"/calendars/{httpx.URL(cal_id).path or cal_id}/events"
                          if False else f"/calendars/{cal_id}/events",
                          {"timeMin": time_min, "timeMax": time_max,
                           "singleEvents": "true", "orderBy": "startTime", "maxResults": 2500})
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
    cals = [(c["id"], c.get("backgroundColor") or "#4285f4")
            for c in cal_data.get("items", []) if not c.get("hidden")]
    results = await asyncio.gather(*[_events_for(cid, color, time_min, time_max)
                                     for cid, color in cals])
    return {"events": [e for sub in results for e in sub]}
```

Add `_to_rfc3339(s, is_end)`: if `s` looks like `YYYY-MM-DD`, append `T00:00:00Z`
(start) / `T23:59:59Z` (end); if already ISO, pass through; reconcile against the
Task 1 probe of what the frontend sends.

NOTE: calendar ids contain `@`/`#` — URL-encode them in the path
(`httpx` quotes path params; or `urllib.parse.quote(cal_id, safe='')`). Replace
the placeholder `_events_for` path build with a clean `quote(cal_id, safe='')`.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Verify live.** `curl 'localhost:8800/api/calendar/events?start=2026-06-01&end=2026-06-30'` → real events across calendars with colors.

- [ ] **Step 6: Commit.** `git commit -am "feat(calendar): fetch events across calendars (concurrent)"`

---

## Task 5: Create event — `POST /api/calendar/events` (self-cleaning test)

**Files:** Modify `backend/calendar_google.py`, test file.

- [ ] **Step 1: Failing test for the body mapper**

```python
from backend.calendar_google import to_google_event

def test_to_google_event_timed():
    g = to_google_event({"summary": "X", "dtstart": "2026-06-04T13:00:00-04:00",
                          "dtend": "2026-06-04T13:30:00-04:00", "all_day": False,
                          "location": "Zoom"})
    assert g["summary"] == "X" and g["start"]["dateTime"] == "2026-06-04T13:00:00-04:00"
    assert g["location"] == "Zoom"

def test_to_google_event_all_day():
    g = to_google_event({"summary": "Y", "dtstart": "2026-07-04", "dtend": "2026-07-05",
                         "all_day": True})
    assert g["start"]["date"] == "2026-07-04" and "dateTime" not in g["start"]
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement body mapper + insert + _post/_delete helpers**

```python
import urllib.parse

async def _post(path: str, body: dict) -> dict:
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.post(f"{_API}{path}", json=body,
                         headers={"Authorization": f"Bearer {google_auth.access_token()}"})
    r.raise_for_status()
    return r.json()

def to_google_event(d: dict) -> dict:
    g = {"summary": d.get("summary") or "", "location": d.get("location") or "",
         "description": d.get("description") or ""}
    if d.get("all_day"):
        g["start"] = {"date": d.get("dtstart")}
        g["end"] = {"date": d.get("dtend") or d.get("dtstart")}
    else:
        g["start"] = {"dateTime": d.get("dtstart")}
        g["end"] = {"dateTime": d.get("dtend") or d.get("dtstart")}
    return g

def _cal_path(cal_id: str) -> str:
    return urllib.parse.quote(cal_id or "primary", safe="")

@router.post("/api/calendar/events")
async def create_event(payload: dict = Body(...)):
    cal = payload.get("calendar") or "primary"
    try:
        g = await _post(f"/calendars/{_cal_path(cal)}/events", to_google_event(payload))
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"error": f"{exc!r}"})
    color = payload.get("color") or "#4285f4"
    return map_event(g, cal, color)
```

(Replace the Task-4 placeholder `_events_for` path with `_cal_path(cal_id)` too.)

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Verify live (self-cleaning).** Create a `[workspace test]` event on
primary for tomorrow; confirm it returns a real `uid` and appears in
`/api/calendar/events`. Keep the `uid` for Task 6's delete.

```bash
curl -s -X POST localhost:8800/api/calendar/events -H 'Content-Type: application/json' \
 -d '{"summary":"[workspace test]","dtstart":"2026-06-05T15:00:00-04:00","dtend":"2026-06-05T15:15:00-04:00","all_day":false}'
```

- [ ] **Step 6: Commit.** `git commit -am "feat(calendar): create events"`

---

## Task 6: Update + Delete — `PUT`/`DELETE /api/calendar/events/{uid}`

**Files:** Modify `backend/calendar_google.py`

- [ ] **Step 1: Implement patch + delete**

```python
@router.put("/api/calendar/events/{uid}")
async def update_event(uid: str, payload: dict = Body(...)):
    cal = payload.get("calendar") or "primary"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.patch(f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}",
                          json=to_google_event(payload),
                          headers={"Authorization": f"Bearer {google_auth.access_token()}"})
    if r.status_code >= 300:
        return JSONResponse(status_code=502, content={"error": r.text[:300]})
    return map_event(r.json(), cal, payload.get("color") or "#4285f4")

@router.delete("/api/calendar/events/{uid}")
async def delete_event(uid: str, request: Request):
    cal = request.query_params.get("calendar") or "primary"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.delete(f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}",
                           headers={"Authorization": f"Bearer {google_auth.access_token()}"})
    if r.status_code not in (200, 204):
        return JSONResponse(status_code=502, content={"ok": False, "error": r.text[:300]})
    return {"ok": True, "deleted": [uid]}
```

- [ ] **Step 2: Verify live + cleanup.** PUT the Task-5 test event (change summary),
then DELETE it; confirm it's gone from `/api/calendar/events`. (Cleans up the test.)

- [ ] **Step 3: Commit.** `git commit -am "feat(calendar): update + delete events"`

---

## Task 7: quick-parse — `POST /api/calendar/quick-parse` (brain)

**Files:** Modify `backend/calendar_google.py`

- [ ] **Step 1: Implement via the brain bridge**

```python
import json as _json
from . import bridge, config

async def _brain_once(prompt: str) -> str:
    chunks = []
    async for sse in bridge.stream_turn(prompt, session_key=config.WEB_SESSION_KEY):
        if not sse.startswith("data:"): continue
        line = sse[5:].strip()
        if not line or line == "[DONE]": continue
        try: o = _json.loads(line)
        except Exception: continue
        if isinstance(o, dict) and o.get("delta"): chunks.append(o["delta"])
    return "".join(chunks).strip()

@router.post("/api/calendar/quick-parse")
async def quick_parse(payload: dict = Body(default=None)):
    payload = payload or {}
    text, tz = payload.get("text") or "", payload.get("tz") or "America/New_York"
    prompt = ("Convert this into a calendar event. Output ONLY strict JSON with keys "
              "summary, dtstart, dtend, all_day, location. Use ISO 8601 with the "
              f"timezone offset for {tz}; all_day true → dates YYYY-MM-DD.\n\n{text}")
    try:
        raw = await _brain_once(prompt)
        # tolerate code fences / prose around the JSON
        s = raw[raw.find("{"): raw.rfind("}") + 1]
        event = _json.loads(s)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=503,
                            content={"error": f"quick-parse unavailable ({exc!r})"})
    return event
```

- [ ] **Step 2: Verify live (brain permitting).** `curl -s -X POST localhost:8800/api/calendar/quick-parse -d '{"text":"lunch with Sam Tuesday 1pm","tz":"America/New_York"}' -H 'Content-Type: application/json'` → `{summary, dtstart, …}`. If the brain is stalled, expect the graceful 503.

- [ ] **Step 3: Commit.** `git commit -am "feat(calendar): quick-parse natural language via the brain"`

---

## Task 8: ICS import + sync stub

**Files:** Modify `backend/calendar_google.py`

- [ ] **Step 1: Implement import (stdlib parse) + sync stub**

```python
@router.post("/api/calendar/sync")
async def sync():
    return {"ok": True}   # we fetch live; nothing to sync

@router.post("/api/calendar/import")
async def import_ics(request: Request):
    body = (await request.body()).decode(errors="replace")
    # Minimal VEVENT parse (SUMMARY/DTSTART/DTEND); good enough for hand/standard ICS.
    import re
    events = re.split(r"BEGIN:VEVENT", body)[1:]
    imported = 0
    for block in events:
        def g(key):
            m = re.search(rf"^{key}[^:]*:(.+)$", block, re.M)
            return m.group(1).strip() if m else ""
        summary, dts, dte = g("SUMMARY"), g("DTSTART"), g("DTEND")
        if not dts: continue
        all_day = "VALUE=DATE" in block or (len(dts) == 8)
        def iso(v):  # 20260704 -> 2026-07-04 ; 20260704T130000Z -> ISO
            if len(v) == 8: return f"{v[:4]}-{v[4:6]}-{v[6:8]}"
            if "T" in v: return f"{v[:4]}-{v[4:6]}-{v[6:8]}T{v[9:11]}:{v[11:13]}:{v[13:15]}Z"
            return v
        try:
            await _post("/calendars/primary/events",
                        to_google_event({"summary": summary, "all_day": all_day,
                                         "dtstart": iso(dts), "dtend": iso(dte) if dte else iso(dts)}))
            imported += 1
        except Exception:  # noqa: BLE001
            pass
    return {"ok": True, "imported": imported}
```

- [ ] **Step 2: Verify live (self-cleaning).** POST a tiny one-VEVENT ICS; confirm
`imported:1` and it appears; then delete it via Task-6 delete.

- [ ] **Step 3: Commit.** `git commit -am "feat(calendar): ICS import + sync stub"`

---

## Task 9: E2e + pytest + memory

- [ ] **Step 1: Full pass.** Browser (over tailnet): open Calendar → 7 calendars,
events render in week/month, drag-create an event, delete it, quick-parse a phrase.
- [ ] **Step 2: `.venv/bin/python -m pytest backend/tests -q`** → all PASS.
- [ ] **Step 3: Update `project_openclaw_workspace_surfaces.md`:** Calendar DONE —
Google Calendar via reused google-calendar-mcp token (`google_auth.py` +
`calendar_google.py`); calendars/events/create/update/delete/quick-parse/import.
- [ ] **Step 4: Commit.** `git commit -am "docs: calendar surface done; update memory"`

---

## Self-Review

**Spec coverage:** auth (T2), calendars (T3), events read (T4), create (T5),
update/delete (T6), quick-parse (T7), import + sync (T8) — all spec endpoints have
tasks. ✅
**Placeholders:** the Task-4 `_events_for` path has an intentionally-ugly inline
that Step-3 NOTE + Task-5 replace with `_cal_path()`; flagged, not silent. Date
`_to_rfc3339` + the exact Google field names are reconciled against the Task-1
probe (honest external-API discovery). ✅
**Type consistency:** `map_calendar`, `map_event(e, cal_id, color)`,
`to_google_event`, `_cal_path`, `google_auth.access_token` used consistently;
uid/cal ids are `str`, URL-encoded on paths. ✅
