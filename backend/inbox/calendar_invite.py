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


_PARTSTAT = {"accepted": "ACCEPTED", "tentative": "TENTATIVE",
             "declined": "DECLINED"}
_STATUS_WORD = {"accepted": "Accepted", "tentative": "Tentative",
                "declined": "Declined"}


def _fold(line: str) -> str:
    """RFC 5545: fold lines longer than 75 octets with CRLF + a space, never
    splitting inside a multi-byte UTF-8 codepoint."""
    b = line.encode("utf-8")
    if len(b) <= 75:
        return line
    out, start = [], 0
    while start < len(b):
        end = min(start + 75, len(b))
        # back off any UTF-8 continuation bytes (0b10xxxxxx) so we cut on a
        # codepoint boundary
        while end < len(b) and (b[end] & 0xC0) == 0x80:
            end -= 1
        out.append(b[start:end].decode("utf-8"))
        start = end
    return "\r\n ".join(out)


def reply_subject(status: str, summary: str) -> str:
    return f"{_STATUS_WORD.get(status, status.title())}: {summary}".rstrip(": ")


def build_reply(invite: dict, attendee_addr: str, status: str,
                dtstamp: str) -> str:
    """Build a METHOD:REPLY VCALENDAR. `dtstamp` is 'YYYYMMDDTHHMMSSZ' supplied
    by the caller (no ambient clock in pure code)."""
    partstat = _PARTSTAT.get(status)
    if partstat is None:
        raise CalendarError(f"invalid RSVP status '{status}'")
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//OpenClaw Workspace//RSVP//EN",
        "METHOD:REPLY",
        "BEGIN:VEVENT",
        f"UID:{invite['uid']}",
        f"SEQUENCE:{invite.get('sequence', 0)}",
        invite.get("organizer_line")
        or f"ORGANIZER:mailto:{invite['organizer_email']}",
        f"ATTENDEE;PARTSTAT={partstat};CN={attendee_addr}:mailto:{attendee_addr}",
        f"DTSTAMP:{dtstamp}",
    ]
    for key in ("dtstart_line", "dtend_line", "recurrence_id_line"):
        if invite.get(key):
            lines.append(invite[key])
    lines += [f"SUMMARY:{invite.get('summary', '')}", "END:VEVENT",
              "END:VCALENDAR"]
    return "\r\n".join(_fold(ln) for ln in lines) + "\r\n"
