"""Minimal iCalendar (RFC 5545) VEVENT support — just what the calendar tab
needs: parse VEVENTs out of CalDAV calendar-data, and build a VCALENDAR for a
single event. Dependency-free. Handles line folding, TEXT escaping, and the two
time forms we support: UTC instants (…Z) and all-day (VALUE=DATE)."""
from __future__ import annotations

import re
from datetime import datetime, timezone

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
    """canonical ISO → (param_suffix, ical_value).

    Timed datetimes are normalized to a UTC instant (…Z): an ISO value carrying
    a numeric offset (e.g. 2026-06-10T18:00:00-04:00, which `quick-parse`
    emits) is converted to UTC, NOT naively stripped — a bare replace() would
    mangle the offset into the time and produce an invalid RFC-5545 value. A
    naive datetime (no tz) becomes a valid floating-local time (no Z)."""
    if all_day:
        d = iso[:10].replace("-", "")
        return ";VALUE=DATE", d
    try:
        dt = datetime.fromisoformat(iso.strip().replace("Z", "+00:00"))
    except ValueError:
        # Unparseable: fall back to the legacy compact strip (best effort).
        return "", iso.replace("-", "").replace(":", "")
    if dt.tzinfo is not None:                      # offset-aware → UTC instant
        return "", dt.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return "", dt.strftime("%Y%m%dT%H%M%S")        # naive → floating local time


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
