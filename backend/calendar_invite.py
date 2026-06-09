"""Pure parser for iCalendar (.ics) invites embedded in emails.

Extracts the first VEVENT into a flat dict the inbox reader renders as a
When/Where/Organizer card. Dependency-free (stdlib only); TZID datetimes are
resolved via zoneinfo when available. Read-only — no RSVP/write here."""
from __future__ import annotations

import re
from datetime import datetime, timezone

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - zoneinfo ships with 3.9+
    ZoneInfo = None


def _unfold(text: str) -> str:
    """RFC5545 line folding: a line break followed by space/tab continues the
    previous line."""
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    return re.sub(r"\n[ \t]", "", text)


def _unescape(val: str) -> str:
    return (val.replace("\\n", "\n").replace("\\N", "\n")
               .replace("\\,", ",").replace("\\;", ";")
               .replace("\\\\", "\\"))


def _parse_line(line: str):
    """`NAME;PARAM=v;P2=v:VALUE` -> (NAME, {PARAM: v}, VALUE)."""
    if ":" not in line:
        return None
    head, _, value = line.partition(":")
    parts = head.split(";")
    params = {}
    for p in parts[1:]:
        if "=" in p:
            k, v = p.split("=", 1)
            params[k.upper()] = v
    return parts[0].upper(), params, value


def _parse_dt(params: dict, value: str) -> dict:
    all_day = (params.get("VALUE", "").upper() == "DATE"
               or bool(re.fullmatch(r"\d{8}", value or "")))
    tzid = params.get("TZID")
    out = {"raw": value, "all_day": all_day, "tzid": tzid, "iso": None}
    try:
        if all_day:
            out["iso"] = datetime.strptime(value[:8], "%Y%m%d").date().isoformat()
        else:
            m = re.match(r"(\d{8}T\d{6})(Z)?", value or "")
            if not m:
                return out
            dt = datetime.strptime(m.group(1), "%Y%m%dT%H%M%S")
            if m.group(2):                       # trailing Z => UTC
                dt = dt.replace(tzinfo=timezone.utc)
            elif tzid and ZoneInfo:
                try:
                    dt = dt.replace(tzinfo=ZoneInfo(tzid))
                except Exception:                # unknown tz -> leave floating
                    pass
            out["iso"] = dt.isoformat()
    except Exception:
        pass
    return out


def _parse_person(params: dict, value: str) -> dict:
    addr = re.sub(r"(?i)^mailto:", "", value or "").strip()
    name = params.get("CN", "").strip().strip('"')
    return {"name": name or addr, "email": addr}


def parse_ics_calendar(text: str | None) -> dict | None:
    """Parse the first VEVENT from an .ics blob. Returns None if there is none."""
    if not text or "BEGIN:VEVENT" not in text:
        return None
    text = _unfold(text)
    method = None
    mm = re.search(r"(?im)^METHOD:(.+)$", text)
    if mm:
        method = mm.group(1).strip().upper()
    block = re.search(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.S)
    if not block:
        return None
    ev = {"summary": "", "location": "", "description": "", "organizer": None,
          "attendees": [], "method": method, "status": None,
          "start": None, "end": None, "rrule": None}
    for line in block.group(1).splitlines():
        line = line.strip()
        if not line:
            continue
        parsed = _parse_line(line)
        if not parsed:
            continue
        name, params, value = parsed
        if name == "SUMMARY":
            ev["summary"] = _unescape(value)
        elif name == "LOCATION":
            ev["location"] = _unescape(value)
        elif name == "DESCRIPTION":
            ev["description"] = _unescape(value)
        elif name == "DTSTART":
            ev["start"] = _parse_dt(params, value)
        elif name == "DTEND":
            ev["end"] = _parse_dt(params, value)
        elif name == "ORGANIZER":
            ev["organizer"] = _parse_person(params, value)
        elif name == "ATTENDEE":
            person = _parse_person(params, value)
            person["partstat"] = params.get("PARTSTAT", "").upper() or None
            ev["attendees"].append(person)
        elif name == "STATUS":
            ev["status"] = value.strip().upper()
        elif name == "RRULE":
            ev["rrule"] = value.strip()
    return ev
