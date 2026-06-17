# v2 Phase 2b — Calendar / CalDAV provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the calendar tab provider-pluggable and add a **CalDAV** provider (works with Google/iCloud/Fastmail/Nextcloud via a CalDAV URL + app-password, no per-user GCP project), keeping the existing Google provider as the default so the maintainer's calendar is unchanged.

**Architecture:** A dependency-free iCalendar VEVENT (de)serializer (`backend/ical.py`) + a CalDAV client over `httpx` (`backend/calendar_caldav.py`) that returns the SAME canonical dicts the Google backend already returns. The existing `calendar_google.py` is refactored to expose its 5 operations as plain async functions; a new `backend/calendar.py` router selects the provider from `.data/calendar.json` and dispatches. Endpoints, payloads, and the frontend are unchanged.

**Tech Stack:** Python 3.11+ (`httpx`, `xml.etree.ElementTree`, no new deps), pytest (network-free via monkeypatched httpx + fixture XML), CalDAV/RFC 4791, iCalendar/RFC 5545 basics.

**Spec:** `docs/superpowers/specs/2026-06-09-v2-phase2-generalized-integrations-design.md` (§2b)

**Canonical shapes (a provider MUST return exactly these):**
- calendar: `{"href","name","color","hex","primary"}`
- event: `{"uid","summary","dtstart","dtend","all_day","location","description","color","event_type","calendar"}`

**Provider interface (5 async functions each provider module exposes):**
`list_calendars() -> list[cal]`, `list_events(time_min, time_max) -> list[event]`,
`create_event(payload) -> event`, `update_event(uid, payload) -> event`,
`delete_event(uid, calendar) -> dict`.

**Scope guards (from the spec):** single + all-day events; recurring events are read as the server expands them (time-range REPORT); no RRULE authoring; UTC/floating times only; the user supplies a CalDAV **collection home URL** (we PROPFIND Depth:1 under it) — no principal auto-discovery.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `backend/ical.py` | pure iCalendar VEVENT parse + VCALENDAR build | Create |
| `backend/calendar_config.py` | provider() selector + CalDAV settings (URL/user/password) | Create |
| `backend/calendar_caldav.py` | CalDAV client (PROPFIND/REPORT/PUT/DELETE) → canonical dicts | Create |
| `backend/calendar_google.py` | extract 5 provider functions; drop its router/decorators | Modify |
| `backend/calendar.py` | the router; `_provider()` dispatch; quick-parse/sync/import | Create |
| `backend/app.py` | import the calendar router from `calendar` not `calendar_google` | Modify |
| `backend/capabilities.py` | `_calendar()` also available for configured CalDAV | Modify |
| `scripts/setup.sh` | `--add-calendar` mode | Modify |
| `README.md` | Optional integrations → Calendar | Modify |
| `backend/tests/test_ical.py`, `test_calendar_caldav.py`, `test_calendar_config.py`, `test_calendar_router.py` | tests | Create |

---

## Task 1: `backend/ical.py` — iCalendar (de)serializer (pure)

**Files:** Create `backend/ical.py`; Create `backend/tests/test_ical.py`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_ical.py
"""Pure iCalendar VEVENT parse + VCALENDAR build (no I/O, no network)."""
from backend import ical

SAMPLE = (
    "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\n"
    "UID:abc-123\r\nSUMMARY:Lunch with Sam\r\n"
    "DTSTART:20260610T180000Z\r\nDTEND:20260610T190000Z\r\n"
    "LOCATION:Cafe\r\nDESCRIPTION:catch up\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n")

ALLDAY = (
    "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:d1\r\nSUMMARY:Holiday\r\n"
    "DTSTART;VALUE=DATE:20260612\r\nDTEND;VALUE=DATE:20260613\r\n"
    "END:VEVENT\r\nEND:VCALENDAR\r\n")


def test_parse_timed_event():
    evs = ical.parse_events(SAMPLE)
    assert len(evs) == 1
    e = evs[0]
    assert e["uid"] == "abc-123"
    assert e["summary"] == "Lunch with Sam"
    assert e["dtstart"] == "2026-06-10T18:00:00Z"
    assert e["dtend"] == "2026-06-10T19:00:00Z"
    assert e["all_day"] is False
    assert e["location"] == "Cafe" and e["description"] == "catch up"


def test_parse_all_day_event():
    e = ical.parse_events(ALLDAY)[0]
    assert e["all_day"] is True
    assert e["dtstart"] == "2026-06-12" and e["dtend"] == "2026-06-13"


def test_parse_unfolds_long_lines():
    folded = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f1\r\n"
              "SUMMARY:Hello \r\n World\r\nDTSTART:20260610T180000Z\r\n"
              "END:VEVENT\r\nEND:VCALENDAR\r\n")  # RFC5545 line folding: CRLF + space
    assert ical.parse_events(folded)[0]["summary"] == "Hello World"


def test_parse_unescapes_text():
    raw = ("BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:e1\r\n"
           "SUMMARY:A\\, B\\; C\\nD\r\nDTSTART:20260610T180000Z\r\n"
           "END:VEVENT\r\nEND:VCALENDAR\r\n")
    assert ical.parse_events(raw)[0]["summary"] == "A, B; C\nD"


def test_build_timed_roundtrips():
    out = ical.build_vcalendar({
        "uid": "x1", "summary": "Plan, review; ship", "dtstart": "2026-06-10T18:00:00Z",
        "dtend": "2026-06-10T19:00:00Z", "all_day": False, "location": "HQ",
        "description": "line1\nline2"})
    assert "BEGIN:VEVENT" in out and "UID:x1" in out
    assert "DTSTART:20260610T180000Z" in out
    assert "SUMMARY:Plan\\, review\\; ship" in out      # escaped
    assert "DESCRIPTION:line1\\nline2" in out
    back = ical.parse_events(out)[0]
    assert back["summary"] == "Plan, review; ship" and back["dtstart"] == "2026-06-10T18:00:00Z"


def test_build_all_day():
    out = ical.build_vcalendar({"uid": "a1", "summary": "Off", "dtstart": "2026-06-12",
                                "dtend": "2026-06-13", "all_day": True})
    assert "DTSTART;VALUE=DATE:20260612" in out
    assert "DTEND;VALUE=DATE:20260613" in out
```

- [ ] **Step 2: Run → FAIL** (`No module named 'backend.ical'`).

Run: `.venv/bin/python -m pytest backend/tests/test_ical.py -q`

- [ ] **Step 3: Implement `backend/ical.py`**

```python
"""Minimal iCalendar (RFC 5545) VEVENT support — just what the calendar tab
needs: parse VEVENTs out of CalDAV calendar-data, and build a VCALENDAR for a
single event. Dependency-free. Handles line folding, TEXT escaping, and the two
time forms we support: UTC instants (…Z) and all-day (VALUE=DATE)."""
from __future__ import annotations

import re

_DT_UTC = re.compile(r"^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$")
_DT_DATE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")


def _unfold(text: str) -> list[str]:
    # RFC5545 folding: a CRLF (or LF) followed by a space/tab continues the line.
    return text.replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "").split("\n")


def _unescape(v: str) -> str:
    out, i = [], 0
    while i < len(v):
        c = v[i]
        if c == "\\" and i + 1 < len(v):
            nxt = v[i + 1]
            out.append({"n": "\n", "N": "\n", ",": ",", ";": ";", "\\": "\\"}.get(nxt, nxt))
            i += 2
        else:
            out.append(c)
            i += 1
    return "".join(out)


def _escape(v: str) -> str:
    return (v.replace("\\", "\\\\").replace("\n", "\\n")
            .replace(",", "\\,").replace(";", "\\;"))


def _parse_dt(value: str) -> tuple[str, bool]:
    """Return (iso, all_day). UTC instant → ISO 'Z'; DATE → 'YYYY-MM-DD'."""
    m = _DT_UTC.match(value)
    if m:
        y, mo, d, h, mi, s = m.groups()
        return f"{y}-{mo}-{d}T{h}:{mi}:{s}Z", False
    m = _DT_DATE.match(value)
    if m:
        y, mo, d = m.groups()
        return f"{y}-{mo}-{d}", True
    return value, False  # unknown form (e.g. local TZID) → pass through, treat as timed


def _split_prop(line: str) -> tuple[str, dict, str]:
    """'DTSTART;VALUE=DATE:2026...' → ('DTSTART', {'VALUE':'DATE'}, '2026...')."""
    name_params, _, value = line.partition(":")
    parts = name_params.split(";")
    name = parts[0].upper()
    params = {}
    for p in parts[1:]:
        k, _, v = p.partition("=")
        params[k.upper()] = v
    return name, params, value


def parse_events(calendar_text: str) -> list[dict]:
    """Parse every VEVENT in an iCalendar blob into canonical event dicts
    (without color/calendar/event_type — the caller fills those)."""
    events: list[dict] = []
    cur: dict | None = None
    for line in _unfold(calendar_text):
        if line == "BEGIN:VEVENT":
            cur = {"uid": "", "summary": "", "dtstart": "", "dtend": "",
                   "all_day": False, "location": "", "description": ""}
            continue
        if line == "END:VEVENT":
            if cur is not None:
                events.append(cur)
            cur = None
            continue
        if cur is None:
            continue
        name, params, value = _split_prop(line)
        if name == "UID":
            cur["uid"] = value.strip()
        elif name == "SUMMARY":
            cur["summary"] = _unescape(value)
        elif name == "LOCATION":
            cur["location"] = _unescape(value)
        elif name == "DESCRIPTION":
            cur["description"] = _unescape(value)
        elif name == "DTSTART":
            iso, all_day = _parse_dt(value)
            cur["dtstart"], cur["all_day"] = iso, all_day or params.get("VALUE") == "DATE"
        elif name == "DTEND":
            iso, _ = _parse_dt(value)
            cur["dtend"] = iso
    return events


def _to_ical_dt(iso: str, all_day: bool) -> tuple[str, str]:
    """canonical ISO → (param_suffix, ical_value)."""
    if all_day:
        d = iso[:10].replace("-", "")
        return ";VALUE=DATE", d
    # 2026-06-10T18:00:00Z → 20260610T180000Z
    s = iso.replace("-", "").replace(":", "")
    return "", s


def build_vcalendar(event: dict) -> str:
    """Build a one-event VCALENDAR for PUTting to CalDAV."""
    all_day = bool(event.get("all_day"))
    sp, sv = _to_ical_dt(event.get("dtstart") or "", all_day)
    ep, ev = _to_ical_dt(event.get("dtend") or event.get("dtstart") or "", all_day)
    lines = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenClaw Workspace//EN",
        "BEGIN:VEVENT",
        f"UID:{event.get('uid') or ''}",
        f"SUMMARY:{_escape(event.get('summary') or '')}",
        f"DTSTART{sp}:{sv}",
        f"DTEND{ep}:{ev}",
    ]
    if event.get("location"):
        lines.append(f"LOCATION:{_escape(event['location'])}")
    if event.get("description"):
        lines.append(f"DESCRIPTION:{_escape(event['description'])}")
    lines += ["END:VEVENT", "END:VCALENDAR"]
    return "\r\n".join(lines) + "\r\n"
```

- [ ] **Step 4: Run → PASS** (7 tests).
- [ ] **Step 5: Commit**

```bash
git add backend/ical.py backend/tests/test_ical.py
git commit -m "feat(calendar): dependency-free iCalendar VEVENT parse + VCALENDAR build"
```

---

## Task 2: `backend/calendar_config.py` — provider selector + CalDAV settings

**Files:** Create `backend/calendar_config.py`; Create `backend/tests/test_calendar_config.py`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_calendar_config.py
"""Calendar provider selection + CalDAV settings (env > .data/calendar.json > default)."""
import json

import pytest

from backend import calendar_config as cc


@pytest.fixture
def iso(tmp_path, monkeypatch):
    monkeypatch.setattr(cc, "CALENDAR_PATH", tmp_path / "calendar.json")
    monkeypatch.setattr(cc, "SECRET_PATH", tmp_path / "secrets" / "caldav-password")
    for v in ("CALENDAR_PROVIDER", "CALDAV_URL", "CALDAV_USERNAME", "CALDAV_PASSWORD"):
        monkeypatch.delenv(v, raising=False)
    return monkeypatch


def test_default_provider_is_google(iso):
    assert cc.provider() == "google"


def test_provider_from_file(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps({"provider": "caldav"}))
    assert cc.provider() == "caldav"


def test_provider_env_wins(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps({"provider": "caldav"}))
    iso.setenv("CALENDAR_PROVIDER", "google")
    assert cc.provider() == "google"


def test_caldav_settings_from_file_and_secret(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps(
        {"provider": "caldav", "caldav": {"url": "https://d.example/cal/", "username": "u"}}))
    sp = tmp_path / "secrets" / "caldav-password"
    sp.parent.mkdir(parents=True)
    sp.write_text("pw")
    s = cc.caldav_settings()
    assert s == {"url": "https://d.example/cal/", "username": "u", "password": "pw"}


def test_caldav_password_env_wins(iso, tmp_path):
    (tmp_path / "calendar.json").write_text(json.dumps(
        {"caldav": {"url": "https://d.example/cal/", "username": "u"}}))
    iso.setenv("CALDAV_PASSWORD", "envpw")
    assert cc.caldav_settings()["password"] == "envpw"
```

- [ ] **Step 2: Run → FAIL** (no module).
- [ ] **Step 3: Implement `backend/calendar_config.py`**

```python
"""Which calendar provider to use, and the CalDAV connection settings.
Non-secret bits live in .data/calendar.json; the CalDAV password lives in a
mode-600 secret file (or CALDAV_PASSWORD env) — never in the JSON, mirroring the
Phase-1 connection.json discipline. Default provider 'google' keeps the
maintainer's existing setup working untouched."""
from __future__ import annotations

import json
import os
from pathlib import Path

from . import config

CALENDAR_PATH = config.DATA_DIR / "calendar.json"
SECRET_PATH = config.DATA_DIR / "secrets" / "caldav-password"


def _load() -> dict:
    try:
        return json.loads(CALENDAR_PATH.read_text())
    except (FileNotFoundError, ValueError):
        return {}


def provider() -> str:
    return (os.environ.get("CALENDAR_PROVIDER") or _load().get("provider") or "google")


def _password() -> str:
    env = os.environ.get("CALDAV_PASSWORD")
    if env:
        return env
    try:
        return SECRET_PATH.read_text().strip()
    except FileNotFoundError:
        return ""


def caldav_settings() -> dict:
    cd = _load().get("caldav") or {}
    return {
        "url": os.environ.get("CALDAV_URL") or cd.get("url") or "",
        "username": os.environ.get("CALDAV_USERNAME") or cd.get("username") or "",
        "password": _password(),
    }
```

- [ ] **Step 4: Run → PASS** (5 tests).
- [ ] **Step 5: Commit**

```bash
git add backend/calendar_config.py backend/tests/test_calendar_config.py
git commit -m "feat(calendar): provider selector + CalDAV settings (password kept out of json)"
```

---

## Task 3: `backend/calendar_caldav.py` — CalDAV client

**Files:** Create `backend/calendar_caldav.py`; Create `backend/tests/test_calendar_caldav.py`.

The client speaks CalDAV with `httpx` Basic auth. XML parsing uses
`xml.etree.ElementTree` with the `DAV:` / `urn:ietf:params:xml:ns:caldav` /
`http://apple.com/ns/ical/` namespaces. Tests monkeypatch the HTTP layer so no
network is used.

- [ ] **Step 1: Write the failing test (fixture XML captured from a real CalDAV server shape)**

```python
# backend/tests/test_calendar_caldav.py
"""CalDAV client: PROPFIND→calendars, REPORT→events, build PUT body. Network-free
(the _request helper is monkeypatched to return fixture (status, text))."""
import pytest

from backend import calendar_caldav as cd

PROPFIND_XML = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"
               xmlns:ic="http://apple.com/ns/ical/">
  <d:response>
    <d:href>/cal/personal/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Personal</d:displayname>
      <d:resourcetype><d:collection/><c:calendar/></d:resourcetype>
      <ic:calendar-color>#FF0000</ic:calendar-color>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
  <d:response>
    <d:href>/cal/</d:href>
    <d:propstat><d:prop>
      <d:displayname>Home</d:displayname>
      <d:resourcetype><d:collection/></d:resourcetype>
    </d:prop></d:propstat>
  </d:response>
</d:multistatus>"""

REPORT_XML = """<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:response>
    <d:href>/cal/personal/ev1.ics</d:href>
    <d:propstat><d:prop>
      <c:calendar-data>BEGIN:VCALENDAR\r
BEGIN:VEVENT\r
UID:ev1\r
SUMMARY:Standup\r
DTSTART:20260610T150000Z\r
DTEND:20260610T151500Z\r
END:VEVENT\r
END:VCALENDAR\r
</c:calendar-data>
    </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  </d:response>
</d:multistatus>"""


def _patch(monkeypatch, status, text):
    async def fake_request(method, url, *, body=None, depth=None, content_type=None):
        return status, text
    monkeypatch.setattr(cd, "_request", fake_request)
    monkeypatch.setattr(cd.calendar_config, "caldav_settings",
                        lambda: {"url": "https://dav.example/cal/", "username": "u",
                                 "password": "p"})


def test_parse_calendars_filters_non_calendar_collections(monkeypatch):
    import asyncio
    _patch(monkeypatch, 207, PROPFIND_XML)
    cals = asyncio.run(cd.list_calendars())
    assert len(cals) == 1                      # only the c:calendar one
    assert cals[0]["name"] == "Personal"
    assert cals[0]["href"].endswith("/cal/personal/")
    assert cals[0]["hex"] == "#FF0000"


def test_parse_events_via_report(monkeypatch):
    import asyncio
    _patch(monkeypatch, 207, REPORT_XML)
    evs = asyncio.run(cd.list_events("2026-06-10T00:00:00Z", "2026-06-11T00:00:00Z"))
    assert len(evs) == 1
    assert evs[0]["uid"] == "ev1" and evs[0]["summary"] == "Standup"
    assert evs[0]["calendar"].endswith("/cal/personal/ev1.ics")


def test_time_range_filter_built():
    body = cd._calendar_query_body("20260610T000000Z", "20260611T000000Z")
    assert "time-range" in body and 'start="20260610T000000Z"' in body
```

(Note: `list_events` first PROPFINDs calendars then REPORTs each; the `_patch`
returns the same fixture for every call, so the test asserts on the REPORT shape.
To keep `list_calendars` returning the PROPFIND fixture and `list_events`'s inner
REPORT returning the REPORT fixture in ONE test would need per-URL fixtures; the
two tests above patch one fixture each, which is sufficient.)

- [ ] **Step 2: Run → FAIL** (no module).
- [ ] **Step 3: Implement `backend/calendar_caldav.py`**

```python
"""CalDAV provider (RFC 4791) over httpx. Returns the SAME canonical calendar /
event dicts as the Google provider. Auth is HTTP Basic (username + app-password).
The user gives a calendar *home* collection URL; we PROPFIND Depth:1 to list the
calendars under it, and calendar-query REPORT each for events in a time range.
Network-free in tests: `_request` is the single HTTP seam to monkeypatch."""
from __future__ import annotations

import urllib.parse
from xml.etree import ElementTree as ET

import httpx

from . import calendar_config, ical

_DEFAULT_COLOR = "#6ea8fe"
_NS = {"d": "DAV:", "c": "urn:ietf:params:xml:ns:caldav",
       "ic": "http://apple.com/ns/ical/"}


async def _request(method: str, url: str, *, body=None, depth=None, content_type=None):
    """One CalDAV HTTP request → (status_code, text). The only network seam."""
    s = calendar_config.caldav_settings()
    headers = {}
    if depth is not None:
        headers["Depth"] = str(depth)
    if content_type:
        headers["Content-Type"] = content_type
    async with httpx.AsyncClient(timeout=30, follow_redirects=True) as client:
        r = await client.request(method, url, content=body, headers=headers,
                                 auth=(s["username"], s["password"]))
    return r.status_code, r.text


def _abs(href: str) -> str:
    """Resolve a server-relative href against the configured base URL's origin."""
    base = calendar_config.caldav_settings()["url"]
    return urllib.parse.urljoin(base, href)


def _parse_calendars(xml_text: str) -> list[dict]:
    root = ET.fromstring(xml_text)
    out = []
    for resp in root.findall("d:response", _NS):
        rtype = resp.find(".//d:resourcetype", _NS)
        is_cal = rtype is not None and rtype.find("c:calendar", _NS) is not None
        if not is_cal:
            continue
        href = (resp.findtext("d:href", default="", namespaces=_NS) or "").strip()
        name = resp.findtext(".//d:displayname", default="", namespaces=_NS) or href
        color = (resp.findtext(".//ic:calendar-color", default="", namespaces=_NS)
                 or _DEFAULT_COLOR)[:7] or _DEFAULT_COLOR
        out.append({"href": _abs(href), "name": name.strip(), "color": color,
                    "hex": color, "primary": False})
    return out


def _calendar_query_body(start: str, end: str) -> str:
    return (
        '<?xml version="1.0" encoding="utf-8" ?>'
        '<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">'
        '<d:prop><d:getetag/><c:calendar-data/></d:prop>'
        '<c:filter><c:comp-filter name="VCALENDAR">'
        '<c:comp-filter name="VEVENT">'
        f'<c:time-range start="{start}" end="{end}"/>'
        '</c:comp-filter></c:comp-filter></c:filter></c:calendar-query>')


def _ical_compact(iso: str) -> str:
    return iso.replace("-", "").replace(":", "")


async def list_calendars() -> list[dict]:
    base = calendar_config.caldav_settings()["url"]
    if not base:
        return []
    status, text = await _request(
        "PROPFIND", base, depth=1, content_type="application/xml",
        body=('<?xml version="1.0"?><d:propfind xmlns:d="DAV:" '
              'xmlns:c="urn:ietf:params:xml:ns:caldav" '
              'xmlns:ic="http://apple.com/ns/ical/"><d:prop>'
              '<d:displayname/><d:resourcetype/><ic:calendar-color/>'
              '</d:prop></d:propfind>'))
    if status >= 300:
        return []
    return _parse_calendars(text)


async def list_events(time_min: str, time_max: str) -> list[dict]:
    cals = await list_calendars()
    start, end = _ical_compact(time_min), _ical_compact(time_max)
    out: list[dict] = []
    for cal in cals:
        status, text = await _request(
            "REPORT", cal["href"], depth=1, content_type="application/xml",
            body=_calendar_query_body(start, end))
        if status >= 300:
            continue
        try:
            root = ET.fromstring(text)
        except ET.ParseError:
            continue
        for resp in root.findall("d:response", _NS):
            ev_href = (resp.findtext("d:href", default="", namespaces=_NS) or "").strip()
            data = resp.findtext(".//c:calendar-data", default="", namespaces=_NS)
            for e in ical.parse_events(data or ""):
                e["color"] = cal["color"]
                e["event_type"] = "default"
                e["calendar"] = _abs(ev_href)  # event href = its CalDAV resource URL
                out.append(e)
    return out


def _event_url(payload_calendar: str, uid: str) -> str:
    """Event resource URL = <calendar collection>/<uid>.ics. payload_calendar is
    the calendar href the frontend round-trips from list_events/list_calendars."""
    coll = payload_calendar.rstrip("/") + "/"
    return urllib.parse.urljoin(coll, f"{urllib.parse.quote(uid)}.ics")


async def create_event(payload: dict) -> dict:
    import uuid
    uid = payload.get("uid") or uuid.uuid4().hex
    cal = payload.get("calendar") or calendar_config.caldav_settings()["url"]
    ev = {**payload, "uid": uid}
    url = _event_url(cal, uid)
    status, _ = await _request("PUT", url, body=ical.build_vcalendar(ev),
                               content_type="text/calendar")
    if status >= 300:
        raise RuntimeError(f"CalDAV PUT failed ({status})")
    return {**ev, "color": payload.get("color") or _DEFAULT_COLOR,
            "event_type": "default", "calendar": url,
            "all_day": bool(payload.get("all_day"))}


async def update_event(uid: str, payload: dict) -> dict:
    # The frontend sends the event's CalDAV href back as `calendar`; PUT to it.
    url = payload.get("calendar") or _event_url(
        calendar_config.caldav_settings()["url"], uid)
    ev = {**payload, "uid": uid}
    status, _ = await _request("PUT", url, body=ical.build_vcalendar(ev),
                               content_type="text/calendar")
    if status >= 300:
        raise RuntimeError(f"CalDAV PUT failed ({status})")
    return {**ev, "color": payload.get("color") or _DEFAULT_COLOR,
            "event_type": "default", "calendar": url,
            "all_day": bool(payload.get("all_day"))}


async def delete_event(uid: str, calendar: str) -> dict:
    url = calendar or _event_url(calendar_config.caldav_settings()["url"], uid)
    status, _ = await _request("DELETE", url)
    if status not in (200, 204, 404):
        raise RuntimeError(f"CalDAV DELETE failed ({status})")
    return {"ok": True, "deleted": [uid]}
```

- [ ] **Step 4: Run → PASS** (3 tests).
- [ ] **Step 5: Commit**

```bash
git add backend/calendar_caldav.py backend/tests/test_calendar_caldav.py
git commit -m "feat(calendar): CalDAV provider (PROPFIND/REPORT/PUT/DELETE → canonical dicts)"
```

---

## Task 4: Refactor `calendar_google.py` into provider functions

**Files:** Modify `backend/calendar_google.py`; Test: `backend/tests/test_calendar_google.py` (existing — keep green).

Goal: expose the SAME 5 provider functions (`list_calendars`, `list_events`,
`create_event`, `update_event`, `delete_event`) as plain async functions returning
the canonical dicts, and REMOVE the `@router.*` decorators + the router object from
this file (the router moves to `calendar.py` in Task 5). Keep `map_calendar`,
`map_event`, `to_google_event`, `_to_rfc3339`, `_get`, `_post`, `_auth`, `_cal_path`,
and the quick-parse brain helper available for `calendar.py` to import.

- [ ] **Step 1:** Convert the endpoint bodies to functions (no decorators):

```python
async def list_calendars() -> list[dict]:
    data = await _get("/users/me/calendarList")
    return [map_calendar(c) for c in data.get("items", [])]


async def list_events(time_min: str, time_max: str) -> list[dict]:
    tmin, tmax = _to_rfc3339(time_min, False), _to_rfc3339(time_max, True)
    cal_data = await _get("/users/me/calendarList")
    cals = [(c["id"], c.get("backgroundColor") or _DEFAULT_COLOR)
            for c in cal_data.get("items", []) if not c.get("hidden")]
    results = await asyncio.gather(*[_events_for(cid, color, tmin, tmax)
                                     for cid, color in cals])
    return [e for sub in results for e in sub]


async def create_event(payload: dict) -> dict:
    cal = payload.get("calendar") or "primary"
    g = await _post(f"/calendars/{_cal_path(cal)}/events", to_google_event(payload))
    return map_event(g, cal, payload.get("color") or _DEFAULT_COLOR)


async def update_event(uid: str, payload: dict) -> dict:
    cal = payload.get("calendar") or "primary"
    url = f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.patch(url, json=to_google_event(payload), headers=_auth())
    r.raise_for_status()
    return map_event(r.json(), cal, payload.get("color") or _DEFAULT_COLOR)


async def delete_event(uid: str, calendar: str) -> dict:
    cal = calendar or "primary"
    url = f"{_API}/calendars/{_cal_path(cal)}/events/{urllib.parse.quote(uid, safe='')}"
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.delete(url, headers=_auth())
    if r.status_code not in (200, 204):
        raise RuntimeError(r.text[:300])
    return {"ok": True, "deleted": [uid]}
```

Delete the old `@router.get(...)`/`@router.post(...)` decorated functions for
calendars/events/create/update/delete AND the `router = APIRouter()` line and the
quick-parse/sync/import ROUTES (the quick-parse brain *helper* functions move to
`calendar.py`; keep only what's reused). Remove now-unused imports (`Body`,
`Request`, `JSONResponse`, `APIRouter`) from this file if nothing else uses them.

- [ ] **Step 2:** Keep the existing `backend/tests/test_calendar_google.py` passing — it tests `map_calendar`/`map_event`/`to_google_event`/`_to_rfc3339`, which are unchanged. Run:
`.venv/bin/python -m pytest backend/tests/test_calendar_google.py -q` → PASS.

- [ ] **Step 3:** Add a focused test that the new functions return canonical shapes with a mocked `_get` (append to `test_calendar_google.py`):

```python
def test_list_calendars_maps_canonical(monkeypatch):
    import asyncio
    from backend import calendar_google as cg
    async def fake_get(path, params=None):
        return {"items": [{"id": "primary", "summary": "Me", "primary": True,
                           "backgroundColor": "#123456"}]}
    monkeypatch.setattr(cg, "_get", fake_get)
    cals = asyncio.run(cg.list_calendars())
    assert cals == [{"href": "primary", "name": "Me", "color": "#123456",
                     "hex": "#123456", "primary": True}]
```

- [ ] **Step 4:** Run the full calendar_google test file → PASS.
- [ ] **Step 5: Commit**

```bash
git add backend/calendar_google.py backend/tests/test_calendar_google.py
git commit -m "refactor(calendar): expose google provider as plain functions (router moves out)"
```

---

## Task 5: `backend/calendar.py` router + provider dispatch + app.py wiring

**Files:** Create `backend/calendar.py`; Modify `backend/app.py`; Test: `backend/tests/test_calendar_router.py`.

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_calendar_router.py
"""The calendar router dispatches to the configured provider."""
import asyncio

from backend import calendar as cal


def test_provider_module_google(monkeypatch):
    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "google")
    assert cal._provider() is cal.calendar_google


def test_provider_module_caldav(monkeypatch):
    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "caldav")
    assert cal._provider() is cal.calendar_caldav


def test_calendars_endpoint_uses_provider(monkeypatch):
    async def fake_list():
        return [{"href": "x", "name": "X", "color": "#1", "hex": "#1", "primary": False}]
    monkeypatch.setattr(cal.calendar_config, "provider", lambda: "caldav")
    monkeypatch.setattr(cal.calendar_caldav, "list_calendars", fake_list)
    out = asyncio.run(cal.calendars())
    assert out == {"calendars": [{"href": "x", "name": "X", "color": "#1",
                                  "hex": "#1", "primary": False}]}
```

- [ ] **Step 2: Run → FAIL** (no module `backend.calendar`).
- [ ] **Step 3: Implement `backend/calendar.py`** (the router; provider dispatch; the brain-backed quick-parse + ICS import calling the active provider's `create_event`). Move the quick-parse/import bodies here from the old calendar_google.py.

```python
"""Calendar router — dispatches to the configured provider (google | caldav).
Endpoints, payloads, and responses are identical across providers."""
from __future__ import annotations

from fastapi import APIRouter, Body, Request
from fastapi.responses import JSONResponse

from . import calendar_caldav, calendar_config, calendar_google

router = APIRouter()


def _provider():
    return calendar_caldav if calendar_config.provider() == "caldav" else calendar_google


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
    cal = request.query_params.get("calendar") or "primary"
    try:
        return await _provider().delete_event(uid, cal)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"{exc!r}"})


@router.post("/api/calendar/sync")
async def sync():
    return {"ok": True}
```

For **quick-parse** and **import**: copy those two route handlers from the old
`calendar_google.py` verbatim into `calendar.py`, but change their event-creation
call from the Google-specific post to `await _provider().create_event(parsed)`.
(The brain helper `_brain_once` they use also moves here; import `bridge`/`config`
as the old file did.) Keep their endpoint paths (`/api/calendar/quick-parse`,
`/api/calendar/import`) identical.

In `backend/app.py`, change the calendar router import:
```python
from .calendar import router as calendar_router    # was: from .calendar_google import ...
```
(Leave `app.include_router(calendar_router)` as-is.)

- [ ] **Step 4: Run** `.venv/bin/python -m pytest backend/tests/test_calendar_router.py -q` → PASS, then the FULL suite (confirm `from backend.app import app` still imports and all calendar tests pass).
- [ ] **Step 5: Commit**

```bash
git add backend/calendar.py backend/app.py backend/tests/test_calendar_router.py
git commit -m "feat(calendar): provider-dispatching router (google|caldav); app uses it"
```

---

## Task 6: Capability + `setup.sh --add-calendar` + docs

**Files:** Modify `backend/capabilities.py`, `backend/tests/test_capabilities.py`, `scripts/setup.sh`, `README.md`.

- [ ] **Step 1: Extend `_calendar()` for CalDAV** — add a failing test to `test_capabilities.py`:

```python
def test_calendar_available_via_caldav(env, monkeypatch):
    monkeypatch.setattr(caps.calendar_config, "caldav_settings",
                        lambda: {"url": "https://d/cal/", "username": "u", "password": "p"})
    monkeypatch.setattr(caps.calendar_config, "provider", lambda: "caldav")
    monkeypatch.setattr(caps.config, "load_connection",
                        lambda: {"integrations": {"calendar": True}})
    assert caps.snapshot()["calendar"]["available"] is True
```

Then update `_calendar()` in `backend/capabilities.py` to also accept CalDAV:

```python
def _calendar() -> dict:
    from . import calendar_config
    if calendar_config.provider() == "caldav":
        s = calendar_config.caldav_settings()
        if not (s["url"] and s["username"] and s["password"]):
            return _avail(False, "CalDAV not configured",
                          "run: setup.sh --add-calendar")
        if not _enabled("calendar"):
            return _avail(False, "not enabled", "enable with: setup.sh --add-calendar")
        return _avail(True)
    # google (default): existing token-file checks
    keys = Path(os.environ.get("GOOGLE_OAUTH_KEYS")
                or Path.home() / ".gmail-mcp/gcp-oauth.keys.json").expanduser()
    toks = Path(os.environ.get("GOOGLE_CAL_TOKENS")
                or Path.home() / ".config/google-calendar-mcp/tokens.json").expanduser()
    if not (keys.exists() and toks.exists()):
        return _avail(False, "no Google OAuth creds/tokens",
                      "provide Google OAuth creds, then: setup.sh --add-calendar")
    if not _enabled("calendar"):
        return _avail(False, "not enabled", "enable with: setup.sh --add-calendar")
    return _avail(True)
```

Add `import os` and `from pathlib import Path` at the top of capabilities.py if not present (they are — verify). Run `test_capabilities.py` → PASS.

- [ ] **Step 2: `scripts/setup.sh --add-calendar`** — mirror `--add-email`'s standalone-mode pattern. Add vars `ADD_CAL=0`, `CAL_PROVIDER=""`, `CALDAV_URL=""`, `CALDAV_USER=""`; flags `--add-calendar`, `--calendar-provider`, `--caldav-url`, `--caldav-username`; password via `CALDAV_PW` env or hidden prompt. When `--add-calendar`:
  - For provider `caldav`: write `.data/calendar.json` `{"provider":"caldav","caldav":{"url":...,"username":...}}` and the password to `.data/secrets/caldav-password` (the helper below uses `os.open(...,0o600)`; create `.data/secrets` mode 700). For provider `google`: write `{"provider":"google"}`.
  - Set `integrations.calendar=true` in connection.json. Exit 0.

```sh
if [[ "$ADD_CAL" == 1 ]]; then
  [[ -z "$CAL_PROVIDER" ]] && { printf "  Calendar provider [google/caldav]: "; read -r CAL_PROVIDER || true; }
  [[ "$CAL_PROVIDER" == "google" || "$CAL_PROVIDER" == "caldav" ]] || { echo "provider must be google or caldav" >&2; exit 1; }
  if [[ "$CAL_PROVIDER" == "caldav" ]]; then
    [[ -n "$CALDAV_URL" ]]  || { printf "  CalDAV URL (calendar home, e.g. https://caldav.fastmail.com/dav/calendars/user/you/): "; read -r CALDAV_URL || true; }
    [[ -n "$CALDAV_USER" ]] || { printf "  CalDAV username: "; read -r CALDAV_USER || true; }
    [[ -n "$CALDAV_URL" && -n "$CALDAV_USER" ]] || { echo "CalDAV url + username required" >&2; exit 1; }
    [[ -n "${CALDAV_PW:-}" ]] || { printf "  CalDAV app password (hidden): "; read -rs CALDAV_PW || true; echo; }
  fi
  CALDAV_PW="${CALDAV_PW:-}" python3 - "$DATA_DIR" "$CAL_PROVIDER" "$CALDAV_URL" "$CALDAV_USER" <<'PY'
import json, os, sys
data_dir, prov, url, user = sys.argv[1:5]
cal = {"provider": prov}
if prov == "caldav":
    cal["caldav"] = {"url": url, "username": user}
    sdir = os.path.join(data_dir, "secrets"); os.makedirs(sdir, mode=0o700, exist_ok=True)
    sp = os.path.join(sdir, "caldav-password")
    fd = os.open(sp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try: os.write(fd, "".join(os.environ.get("CALDAV_PW","").split()).encode())
    finally: os.close(fd)
os.makedirs(data_dir, exist_ok=True)
json.dump(cal, open(os.path.join(data_dir, "calendar.json"), "w"), indent=2)
open(os.path.join(data_dir, "calendar.json"), "a").write("\n")
conn = os.path.join(data_dir, "connection.json")
try: c = json.load(open(conn))
except Exception: c = {}
c.setdefault("integrations", {})["calendar"] = True
json.dump(c, open(conn, "w"), indent=2); open(conn, "a").write("\n")
print(f"  ✓ calendar provider '{prov}' configured + enabled")
PY
  echo "  Restart the workspace to pick up the calendar."
  exit 0
fi
```
Add the flags to the parser + `--help` block. Place the block next to the `--add-email` block (after arg parse). Verify: `bash -n scripts/setup.sh`; run `WORKSPACE_BUILD_DEST` not needed — just run `CALDAV_PW=pw scripts/setup.sh --add-calendar --calendar-provider caldav --caldav-url https://d/cal/ --caldav-username u` and assert `.data/calendar.json` + `.data/secrets/caldav-password` (mode 600) + `connection.json integrations.calendar=true`; then `rm -f .data/calendar.json .data/secrets/caldav-password .data/connection.json`.

- [ ] **Step 3: README** — under "## Optional integrations", add a "### Calendar" subsection:

```markdown
### Calendar

```bash
scripts/setup.sh --add-calendar       # choose 'caldav' (universal) or 'google'
```

**CalDAV** works with Google, iCloud, Fastmail, Nextcloud, etc. — give your
calendar home URL (e.g. `https://caldav.fastmail.com/dav/calendars/user/you/`),
username, and an app password (stored mode-600, never in the repo). **Google**
(the default) uses OAuth tokens at `GOOGLE_OAUTH_KEYS` / `GOOGLE_CAL_TOKENS`.
Restart the workspace afterward.
```

(Keep code fences balanced — even count.)

- [ ] **Step 4: Commit**

```bash
git add backend/capabilities.py backend/tests/test_capabilities.py scripts/setup.sh README.md
git commit -m "feat(calendar): CalDAV capability + setup.sh --add-calendar + docs"
```

---

## Final verification (after all tasks)

- [ ] Full suite green: `.venv/bin/python -m pytest backend/tests -q` (prior count + ~16 new).
- [ ] `from backend.app import app` imports; `grep -n 'api/calendar' backend/calendar.py` shows all 7 routes; app.py imports the router from `calendar`.
- [ ] **Backward-compat:** with no `.data/calendar.json` (provider defaults `google`), the calendar router dispatches to `calendar_google` and behaves as before (the maintainer's tokens still used). Confirm `cal._provider() is cal.calendar_google` when unconfigured.
- [ ] iCal round-trip + CalDAV parse tests pass; `setup.sh --add-calendar` writes calendar.json + a 600 secret; capability reports available for a configured CalDAV.
- [ ] No personal data / hardcoded paths in the diff.
