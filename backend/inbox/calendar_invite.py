"""Parse incoming iCalendar REQUEST invites and build REPLY responses.

Pure stdlib + hand-built iCal text (RFC 5545). No network/disk I/O so the
mappers stay unit-testable; the backend orchestrator (email_himalaya.perform_rsvp)
supplies the raw bytes and the DTSTAMP."""
from __future__ import annotations

import email
from email.policy import default as _policy
from email.utils import parseaddr


class CalendarError(ValueError):
    """The message is not an actionable calendar invitation."""


def _unfold(text: str) -> list[str]:
    """RFC 5545 line unfolding: a line beginning with space/TAB continues the
    previous one."""
    out: list[str] = []
    for raw in text.splitlines():
        if raw[:1] in (" ", "\t") and out:
            out[-1] += raw[1:]
        else:
            out.append(raw)
    return out


def _prop_name(line: str) -> str:
    """'DTSTART;TZID=...:value' -> 'DTSTART' (name is before ';' or ':')."""
    head = line.split(":", 1)[0]
    return head.split(";", 1)[0].strip().upper()


def _prop_value(line: str) -> str:
    return line.split(":", 1)[1] if ":" in line else ""


def extract_invite(raw: bytes) -> dict | None:
    """Return the VEVENT of a METHOD:REQUEST text/calendar part, or None.

    Keys: uid, sequence(int), summary, location, organizer_email,
    organizer_line, dtstart_line, dtend_line, recurrence_id_line, start_iso,
    end_iso. The *_line values are the full original (unfolded) iCal lines so
    build_reply can copy DTSTART/DTEND/RECURRENCE-ID verbatim (TZID intact)."""
    msg = email.message_from_bytes(raw, policy=_policy)
    cal_text = None
    for part in msg.walk():
        if part.get_content_type() != "text/calendar":
            continue
        try:
            text = part.get_content()
        except Exception:  # noqa: BLE001
            continue
        method = (part.get_param("method") or "").upper()
        if method == "REQUEST" or "METHOD:REQUEST" in text.upper():
            cal_text = text
            break
    if cal_text is None:
        return None

    lines = _unfold(cal_text)
    in_event = False
    inv: dict = {"uid": "", "sequence": 0, "summary": "", "location": "",
                 "organizer_email": "", "organizer_line": "",
                 "dtstart_line": "", "dtend_line": "",
                 "recurrence_id_line": "", "start_iso": "", "end_iso": ""}
    for line in lines:
        name = _prop_name(line)
        if name == "BEGIN" and _prop_value(line).strip().upper() == "VEVENT":
            in_event = True
            continue
        if name == "END" and _prop_value(line).strip().upper() == "VEVENT":
            break
        if not in_event:
            continue
        if name == "UID":
            inv["uid"] = _prop_value(line).strip()
        elif name == "SEQUENCE":
            try:
                inv["sequence"] = int(_prop_value(line).strip() or 0)
            except ValueError:
                inv["sequence"] = 0
        elif name == "SUMMARY":
            inv["summary"] = _prop_value(line).strip()
        elif name == "LOCATION":
            inv["location"] = _prop_value(line).strip()
        elif name == "ORGANIZER":
            inv["organizer_line"] = line
            val = _prop_value(line).strip()
            if "mailto:" in val.lower():
                inv["organizer_email"] = val[val.lower().rindex("mailto:") + 7:].strip()
            else:
                inv["organizer_email"] = parseaddr(val)[1]
        elif name == "DTSTART":
            inv["dtstart_line"] = line
            inv["start_iso"] = _ical_to_iso(_prop_value(line).strip())
        elif name == "DTEND":
            inv["dtend_line"] = line
            inv["end_iso"] = _ical_to_iso(_prop_value(line).strip())
        elif name == "RECURRENCE-ID":
            inv["recurrence_id_line"] = line
    if not inv["uid"]:
        return None
    return inv


def _ical_to_iso(val: str) -> str:
    """Best-effort iCal date/datetime -> ISO 8601 for the UI. Handles
    'YYYYMMDDTHHMMSS[Z]' (datetime) and 'YYYYMMDD' (all-day VALUE=DATE).
    Returns the raw value unchanged if it matches neither (callers treat it
    as opaque)."""
    v = val.strip()
    if len(v) >= 15 and v[8] == "T":
        d, t = v[:8], v[9:15]
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}"
        return iso + "Z" if v.endswith("Z") else iso
    if len(v) == 8 and v.isdigit():
        return f"{v[:4]}-{v[4:6]}-{v[6:8]}"
    return v
