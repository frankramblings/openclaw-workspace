# Calendar-invite RSVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let inbox/email calendar invitations be RSVP'd (Yes/Maybe/No), each action sending an iCalendar REPLY to the organizer then marking the email read and moving it out of INBOX (Yes/Maybe → Archive, No → Trash).

**Architecture:** A pure stdlib module parses the incoming `text/calendar; METHOD:REQUEST` part and builds a `METHOD:REPLY` VCALENDAR. A shared backend orchestrator (`perform_rsvp`) reads the message, sends the reply via the existing himalaya SMTP path, flags it Seen, and moves it. Two endpoints call it: the inbox `/api/items/action` `rsvp` branch and a new `/api/email/rsvp/{uid}`. Detection is cheap-heuristic at envelope time + a capped lazy `.ics` confirm read, to protect the 2014-mini host. Frontend adds RSVP chips to inbox cards and RSVP items to the Email-tab row menu.

**Tech Stack:** Python 3.11 (FastAPI, stdlib `email`/`datetime`), pytest + httpx ASGITransport (`@pytest.mark.anyio`), himalaya CLI, vanilla-JS frontend overlays.

**Spec:** `docs/superpowers/specs/2026-06-08-calendar-rsvp-design.md`

---

## File Structure

- **Create** `backend/inbox/calendar_invite.py` — pure iCal parse/build + `CalendarError`. No I/O.
- **Modify** `backend/email_himalaya.py` — `is_invite_candidate` (heuristic), `build_calendar_reply_mime`, `perform_rsvp` (orchestrator), `calendar` field on `message_to_read`, `POST /api/email/rsvp/{uid}`, `datetime` import.
- **Modify** `backend/inbox/sources/gmail.py` — set `meta.maybeInvite` cheaply; capped lazy `_annotate_invites` adding `meta.calendar` + `rsvp` action.
- **Modify** `backend/inbox/__init__.py` — `rsvp` branch in `/api/items/action`.
- **Create** `backend/tests/test_calendar_invite.py` — pure parse/build tests.
- **Modify** `backend/tests/test_inbox_router.py` — rsvp action wiring test.
- **Modify** `frontend-overrides/js/inbox.js` — RSVP chips on cards; `doAction` `extra` body merge.
- **Modify** `frontend-vendor/js/emailInbox.js` — RSVP menu items on invite rows + `_rsvpEmail`.

DTSTAMP is passed *into* the pure builder (the test harness/codebase forbids ambient clocks); the backend supplies it from `datetime.now(timezone.utc)`.

---

## Task 1: iCal invite extraction (pure)

**Files:**
- Create: `backend/inbox/calendar_invite.py`
- Test: `backend/tests/test_calendar_invite.py`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_calendar_invite.py
"""Pure parse/build tests for calendar_invite (no I/O)."""
from backend.inbox import calendar_invite as ci

GOOGLE_INVITE = (
    b"From: Boss <boss@example.com>\r\n"
    b"To: me@example.com\r\n"
    b"Subject: Invitation: Sync @ Tue\r\n"
    b'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"\r\n'
    b"\r\n"
    b"BEGIN:VCALENDAR\r\n"
    b"VERSION:2.0\r\n"
    b"METHOD:REQUEST\r\n"
    b"BEGIN:VEVENT\r\n"
    b"UID:abc-123@google.com\r\n"
    b"SEQUENCE:2\r\n"
    b"DTSTART;TZID=America/New_York:20260610T100000\r\n"
    b"DTEND;TZID=America/New_York:20260610T103000\r\n"
    b"ORGANIZER;CN=Boss:mailto:boss@example.com\r\n"
    b"SUMMARY:Sync\r\n"
    b"LOCATION:Room 4\r\n"
    b"END:VEVENT\r\n"
    b"END:VCALENDAR\r\n"
)

PLAIN_EMAIL = (
    b"From: a@example.com\r\nSubject: hi\r\n"
    b"Content-Type: text/plain\r\n\r\nnot an invite\r\n"
)


def test_extract_invite_parses_google_request():
    inv = ci.extract_invite(GOOGLE_INVITE)
    assert inv is not None
    assert inv["uid"] == "abc-123@google.com"
    assert inv["sequence"] == 2
    assert inv["summary"] == "Sync"
    assert inv["location"] == "Room 4"
    assert inv["organizer_email"] == "boss@example.com"
    assert inv["organizer_line"] == "ORGANIZER;CN=Boss:mailto:boss@example.com"
    assert inv["dtstart_line"] == "DTSTART;TZID=America/New_York:20260610T100000"
    assert inv["dtend_line"] == "DTEND;TZID=America/New_York:20260610T103000"


def test_extract_invite_returns_none_for_plain_email():
    assert ci.extract_invite(PLAIN_EMAIL) is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.inbox.calendar_invite'`.

- [ ] **Step 3: Write minimal implementation**

```python
# backend/inbox/calendar_invite.py
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
            _, inv["organizer_email"] = parseaddr(_prop_value(line))
            if not inv["organizer_email"]:
                inv["organizer_email"] = _prop_value(line).split(":")[-1].strip()
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
    """Best-effort 'YYYYMMDDTHHMMSS[Z]' -> ISO 8601 for the UI. Returns the raw
    value unchanged if it doesn't match (callers treat it as opaque)."""
    v = val.strip()
    if len(v) >= 15 and v[8] == "T":
        d, t = v[:8], v[9:15]
        iso = f"{d[:4]}-{d[4:6]}-{d[6:8]}T{t[:2]}:{t[2:4]}:{t[4:6]}"
        return iso + "Z" if v.endswith("Z") else iso
    return v
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -v`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/inbox/calendar_invite.py backend/tests/test_calendar_invite.py
git commit -m "feat(calendar): parse incoming iCalendar REQUEST invites

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: iCal REPLY builder (pure)

**Files:**
- Modify: `backend/inbox/calendar_invite.py`
- Test: `backend/tests/test_calendar_invite.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_calendar_invite.py`:

```python
def test_build_reply_accepted():
    inv = ci.extract_invite(GOOGLE_INVITE)
    out = ci.build_reply(inv, "me@example.com", "accepted", "20260609T120000Z")
    assert "METHOD:REPLY" in out
    assert "UID:abc-123@google.com" in out
    assert "SEQUENCE:2" in out
    assert "ORGANIZER;CN=Boss:mailto:boss@example.com" in out
    assert "ATTENDEE;PARTSTAT=ACCEPTED;CN=me@example.com:mailto:me@example.com" in out
    assert "DTSTART;TZID=America/New_York:20260610T100000" in out
    assert "DTSTAMP:20260609T120000Z" in out
    assert out.startswith("BEGIN:VCALENDAR")
    assert out.rstrip().endswith("END:VCALENDAR")


def test_build_reply_rejects_bad_status():
    inv = ci.extract_invite(GOOGLE_INVITE)
    import pytest
    with pytest.raises(ci.CalendarError):
        ci.build_reply(inv, "me@example.com", "perhaps", "20260609T120000Z")


def test_reply_subject():
    assert ci.reply_subject("accepted", "Sync") == "Accepted: Sync"
    assert ci.reply_subject("tentative", "Sync") == "Tentative: Sync"
    assert ci.reply_subject("declined", "Sync") == "Declined: Sync"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -k "reply" -v`
Expected: FAIL — `AttributeError: module ... has no attribute 'build_reply'`.

- [ ] **Step 3: Write minimal implementation**

Append to `backend/inbox/calendar_invite.py`:

```python
_PARTSTAT = {"accepted": "ACCEPTED", "tentative": "TENTATIVE",
             "declined": "DECLINED"}
_STATUS_WORD = {"accepted": "Accepted", "tentative": "Tentative",
                "declined": "Declined"}


def _fold(line: str) -> str:
    """RFC 5545: fold lines longer than 75 octets with CRLF + a space."""
    b = line.encode("utf-8")
    if len(b) <= 75:
        return line
    out, start = [], 0
    while start < len(b):
        chunk = b[start:start + 75]
        out.append(chunk.decode("utf-8", "ignore"))
        start += 75
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -v`
Expected: PASS (5 passed).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/inbox/calendar_invite.py backend/tests/test_calendar_invite.py
git commit -m "feat(calendar): build iCalendar REPLY responses

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Heuristic candidate detection (pure)

**Files:**
- Modify: `backend/email_himalaya.py` (add near `envelope_to_email`, ~line 88)
- Test: `backend/tests/test_calendar_invite.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_calendar_invite.py`:

```python
def test_is_invite_candidate():
    from backend import email_himalaya as eh
    assert eh.is_invite_candidate("Invitation: Sync @ Tue", True, "b@x.com")
    assert eh.is_invite_candidate("Updated invitation: Sync", True, "b@x.com")
    assert not eh.is_invite_candidate("Invitation: Sync", False, "b@x.com")  # no attachment
    assert not eh.is_invite_candidate("Lunch?", True, "b@x.com")             # no pattern
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -k candidate -v`
Expected: FAIL — `AttributeError: module 'backend.email_himalaya' has no attribute 'is_invite_candidate'`.

- [ ] **Step 3: Write minimal implementation**

In `backend/email_himalaya.py`, add the import `from datetime import datetime, timezone` to the import block (after line 16 `import tomllib`), and add this helper just above `def envelope_to_email` (~line 89):

```python
_INVITE_SUBJECT_RE = re.compile(
    r"^\s*(updated invitation|invitation|canceled event|updated event)\s*:",
    re.I)


def is_invite_candidate(subject: str, has_attachment: bool,
                        from_addr: str = "") -> bool:
    """Cheap envelope-only guess that an email is a calendar invite, so the
    expensive .ics body read is bounded to likely candidates (spec §Constraints).
    Confirmed only by calendar_invite.extract_invite after a read."""
    if not has_attachment:
        return False
    return bool(_INVITE_SUBJECT_RE.match(subject or ""))
```

Then set the flag on the list-row shape — in `envelope_to_email`, add to the returned dict (after the `"has_attachments"` line, ~line 106):

```python
        "is_invite_candidate": is_invite_candidate(
            env.get("subject") or "", bool(env.get("has_attachment")),
            (frm.get("addr") or frm.get("address") or "")),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -k candidate -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/email_himalaya.py backend/tests/test_calendar_invite.py
git commit -m "feat(email): heuristic invite-candidate flag on list rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: RSVP orchestrator + reply MIME + endpoint

**Files:**
- Modify: `backend/email_himalaya.py`
- Test: `backend/tests/test_calendar_invite.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_calendar_invite.py`:

```python
import pytest
from httpx import ASGITransport, AsyncClient


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_email_rsvp_endpoint(monkeypatch):
    from backend import email_himalaya as eh
    calls = {}

    async def fake_perform(uid, folder, status):
        calls["args"] = (uid, folder, status)
        return {"status": status, "moved_to": eh.ARCHIVE_FOLDER}

    monkeypatch.setattr(eh, "perform_rsvp", fake_perform)
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://t") as c:
        r = await c.post("/api/email/rsvp/42", json={"rsvp": "accepted"})
    assert r.json() == {"ok": True, "status": "accepted",
                        "moved_to": eh.ARCHIVE_FOLDER}
    assert calls["args"] == ("42", "INBOX", "accepted")


@pytest.mark.anyio
async def test_email_rsvp_rejects_bad_status(monkeypatch):
    from backend.app import app
    async with AsyncClient(transport=ASGITransport(app=app),
                           base_url="http://t") as c:
        r = await c.post("/api/email/rsvp/42", json={"rsvp": "nope"})
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -k rsvp_endpoint -v`
Expected: FAIL — 404 (route missing) / `AttributeError: perform_rsvp`.

- [ ] **Step 3: Write minimal implementation**

In `backend/email_himalaya.py`, add the import at the top: `from .inbox import calendar_invite`. Then add, after `email_send` (~line 369):

```python
# --- calendar RSVP -----------------------------------------------------------

def build_calendar_reply_mime(*, to: str, subject: str, attendee: str,
                              ics: str, status: str) -> bytes:
    """A multipart/alternative reply: a human one-liner + the REPLY .ics part."""
    verb = {"accepted": "has accepted", "tentative": "has tentatively accepted",
            "declined": "has declined"}.get(status, "has responded to")
    m = email.message.EmailMessage()
    m["From"] = _from_header()
    m["To"] = to
    m["Subject"] = subject
    m.set_content(f"{attendee} {verb} this invitation.")
    m.add_alternative(ics, subtype="calendar",
                      params={"method": "REPLY", "charset": "UTF-8",
                              "component": "VEVENT"})
    return m.as_bytes()


async def perform_rsvp(uid: str, folder: str, status: str) -> dict:
    """Send a REPLY to the organizer, mark the email Seen, and move it out of
    INBOX. Yes/Maybe -> Archive, No -> Trash (spec §Goal). Shared by the inbox
    action branch and POST /api/email/rsvp. Raises CalendarError when the
    message isn't an actionable invite."""
    if status not in calendar_invite._PARTSTAT:
        raise calendar_invite.CalendarError(f"invalid RSVP status '{status}'")
    raw = await himalaya_cli.run_raw(
        ["message", "export", uid, "-F", "-f", folder])
    invite = calendar_invite.extract_invite(raw)
    if invite is None:
        raise calendar_invite.CalendarError("not a calendar invitation")
    if not invite.get("organizer_email"):
        raise calendar_invite.CalendarError("invite has no organizer to reply to")
    dtstamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    ics = calendar_invite.build_reply(invite, ACCOUNT_ADDRESS, status, dtstamp)
    mime = build_calendar_reply_mime(
        to=invite["organizer_email"],
        subject=calendar_invite.reply_subject(status, invite["summary"]),
        attendee=ACCOUNT_ADDRESS, ics=ics, status=status)
    await _himalaya_with_retry(["message", "send"], stdin=mime)
    try:  # export doesn't set \Seen; honor mark-read explicitly
        await himalaya_cli.run_raw(["flag", "add", uid, "Seen", "-f", folder])
    except himalaya_cli.HimalayaError:
        pass
    dest = ARCHIVE_FOLDER if status != "declined" else TRASH_FOLDER
    await move_message(uid, folder, dest)
    return {"status": status, "moved_to": dest}


@router.post("/api/email/rsvp/{uid}")
async def email_rsvp(uid: str, payload: dict = Body(default=None),
                     folder: str = "INBOX"):
    payload = payload or {}
    status = (payload.get("rsvp") or "").lower()
    fld = payload.get("folder") or folder
    if status not in calendar_invite._PARTSTAT:
        return JSONResponse(status_code=400,
                            content={"ok": False, "error": "rsvp must be "
                                     "accepted|tentative|declined"})
    try:
        result = await perform_rsvp(uid, fld, status)
    except calendar_invite.CalendarError as exc:
        return JSONResponse(status_code=400,
                            content={"ok": False, "error": str(exc)})
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse(status_code=502,
                            content={"ok": False, "error": str(exc)})
    return {"ok": True, **result}
```

NOTE on import order: `email_himalaya` is imported by `backend.inbox.__init__`, and now imports `backend.inbox.calendar_invite`. `calendar_invite` imports only stdlib, so there is no cycle (`email_himalaya → inbox.calendar_invite`, never back). The `move_message`, `_himalaya_with_retry`, `ARCHIVE_FOLDER`, `TRASH_FOLDER`, and `ACCOUNT_ADDRESS` symbols already exist in this file.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/email_himalaya.py backend/tests/test_calendar_invite.py
git commit -m "feat(email): RSVP orchestrator + /api/email/rsvp endpoint

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Expose calendar block on the Email read view

**Files:**
- Modify: `backend/email_himalaya.py` (`message_to_read`, ~line 153)
- Test: `backend/tests/test_calendar_invite.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_calendar_invite.py`:

```python
def test_message_to_read_attaches_calendar():
    from backend import email_himalaya as eh
    read = eh.message_to_read(GOOGLE_INVITE, "7")
    assert read["calendar"] is not None
    assert read["calendar"]["summary"] == "Sync"
    assert read["calendar"]["organizer"] == "boss@example.com"


def test_message_to_read_no_calendar_for_plain():
    from backend import email_himalaya as eh
    read = eh.message_to_read(PLAIN_EMAIL, "8")
    assert read["calendar"] is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -k message_to_read -v`
Expected: FAIL — `KeyError: 'calendar'`.

- [ ] **Step 3: Write minimal implementation**

In `backend/email_himalaya.py`, inside `message_to_read`, just before the `return {` statement (~line 181), compute the calendar block, then add it to the returned dict:

```python
    invite = calendar_invite.extract_invite(raw)
    calendar = None
    if invite is not None:
        calendar = {"summary": invite["summary"], "location": invite["location"],
                    "organizer": invite["organizer_email"],
                    "startISO": invite["start_iso"], "endISO": invite["end_iso"]}
```

And add this key to the returned dict (e.g. after `"attachments": attachments,`):

```python
        "calendar": calendar,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_calendar_invite.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/email_himalaya.py backend/tests/test_calendar_invite.py
git commit -m "feat(email): expose parsed calendar block on read view

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Inbox source — candidate flag + capped lazy confirm

**Files:**
- Modify: `backend/inbox/sources/gmail.py`
- Test: `backend/tests/test_inbox_gmail.py` (create)

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_inbox_gmail.py
"""gmail source: candidate flag + lazy invite confirm."""
import pytest

from backend.inbox.sources import gmail


def test_map_items_flags_invite_candidate():
    envs = [{"id": "1", "subject": "Invitation: Sync", "flags": [],
             "from": {"addr": "b@x.com"}, "date": "2026-06-10 10:00+00:00",
             "has_attachment": True}]
    items = gmail.map_items(envs, now_ms=1_700_000_000_000)
    assert items[0]["meta"]["maybeInvite"] is True


def test_map_items_no_flag_without_attachment():
    envs = [{"id": "2", "subject": "Invitation: Sync", "flags": [],
             "from": {"addr": "b@x.com"}, "date": "2026-06-10 10:00+00:00",
             "has_attachment": False}]
    items = gmail.map_items(envs, now_ms=1_700_000_000_000)
    assert items[0]["meta"].get("maybeInvite") is not True


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_annotate_invites_sets_calendar(monkeypatch):
    from backend.inbox.sources import gmail as g
    from backend.inbox import calendar_invite

    async def fake_run_raw(args, **kw):
        return b"raw"

    monkeypatch.setattr(g.himalaya_cli, "run_raw", fake_run_raw)
    monkeypatch.setattr(calendar_invite, "extract_invite", lambda raw: {
        "summary": "Sync", "location": "Room 4", "organizer_email": "b@x.com",
        "start_iso": "2026-06-10T10:00:00", "end_iso": "2026-06-10T10:30:00"})
    items = [{"id": "1", "source": "gmail", "score": 5,
              "meta": {"uid": "1", "maybeInvite": True},
              "actions": ["archive", "delete", "dismiss", "snooze"]}]
    await g._annotate_invites(items)
    assert items[0]["meta"]["calendar"]["summary"] == "Sync"
    assert items[0]["actions"] == ["rsvp", "snooze", "dismiss"]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_inbox_gmail.py -v`
Expected: FAIL — `KeyError: 'maybeInvite'` / `AttributeError: _annotate_invites`.

- [ ] **Step 3: Write minimal implementation**

In `backend/inbox/sources/gmail.py`, change the import line (line 14) and add a confirm cap constant:

```python
from ... import email_himalaya, himalaya_cli
from .. import calendar_invite

INVITE_CONFIRM_CAP = int(os.environ.get("INBOX_INVITE_CONFIRM_CAP", "8"))
```

In `map_items`, set the candidate flag in the appended item's `meta` (add to the `"meta"` dict, alongside `uid`/`from`):

```python
            "meta": {"uid": str(env.get("id", "")), "from": addr,
                     "unread": unread, "important": important,
                     "maybeInvite": email_himalaya.is_invite_candidate(
                         env.get("subject") or "",
                         bool(env.get("has_attachment")), addr)},
```

Add the confirm helper (after `map_items`, before `fetch`):

```python
async def _annotate_invites(items: list[dict]) -> None:
    """For up to INVITE_CONFIRM_CAP candidates, read the .ics and confirm. Each
    read is a slow himalaya subprocess on this host, so the cap bounds cost; the
    60s router cache makes it one read per item per window. Confirmed invites
    swap to RSVP-only actions and gain a meta.calendar block."""
    candidates = [i for i in items
                  if i["meta"].get("maybeInvite")][:INVITE_CONFIRM_CAP]
    for it in candidates:
        try:
            raw = await himalaya_cli.run_raw(
                ["message", "export", it["meta"]["uid"], "-F", "-f", "INBOX"])
            invite = calendar_invite.extract_invite(raw)
        except Exception:  # noqa: BLE001 - a failed confirm just leaves the card normal
            invite = None
        if invite:
            it["meta"]["calendar"] = {
                "summary": invite["summary"], "location": invite["location"],
                "organizer": invite["organizer_email"],
                "startISO": invite["start_iso"], "endISO": invite["end_iso"]}
            it["actions"] = ["rsvp", "snooze", "dismiss"]
            it["score"] += 1
```

In `fetch`, call it before returning:

```python
async def fetch() -> list[dict]:
    data = await himalaya_cli.run_json(
        ["envelope", "list", "-f", "INBOX", "-s", str(LIST_SIZE)])
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    items = map_items(envs, now_ms=int(time.time() * 1000))
    await _annotate_invites(items)
    return items
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_inbox_gmail.py -v`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/inbox/sources/gmail.py backend/tests/test_inbox_gmail.py
git commit -m "feat(inbox): detect calendar invites in the gmail source

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Inbox action — rsvp branch

**Files:**
- Modify: `backend/inbox/__init__.py` (action handler, ~line 100)
- Test: `backend/tests/test_inbox_router.py`

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_inbox_router.py`:

```python
@pytest.mark.anyio
async def test_rsvp_action(client, monkeypatch):
    from backend import email_himalaya as eh
    seen = {}

    async def fake_perform(uid, folder, status):
        seen["call"] = (uid, folder, status)
        return {"status": status, "moved_to": eh.ARCHIVE_FOLDER}

    monkeypatch.setattr(eh, "perform_rsvp", fake_perform)
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "rsvp",
                               "rsvp": "accepted", "title": "Sync",
                               "meta": {"from": "b@x.com"}})
        body = r.json()
        assert body["ok"] is True
        r2 = await c.get("/api/items?sources=gmail")
    assert seen["call"] == ("g1", "INBOX", "accepted")
    assert r2.json()["items"] == []   # dismissed after RSVP


@pytest.mark.anyio
async def test_rsvp_bad_status_rejected(client):
    async with client as c:
        r = await c.post("/api/items/action",
                         json={"source": "gmail", "id": "g1", "action": "rsvp",
                               "rsvp": "nope"})
    assert r.status_code == 400
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_inbox_router.py -k rsvp -v`
Expected: FAIL — 400 "unknown action 'rsvp'".

- [ ] **Step 3: Write minimal implementation**

In `backend/inbox/__init__.py`, add a branch inside the `try:` of the `action` handler, after the `delete` branch (~line 131, before `elif act == "mark_read"`):

```python
        elif act == "rsvp" and source == "gmail":
            status = (payload.get("rsvp") or "").lower()
            if status not in ("accepted", "tentative", "declined"):
                return _bad("rsvp must be accepted|tentative|declined")
            result = await email_himalaya.perform_rsvp(item_id, "INBOX", status)
            state.dismiss(source, item_id, f"rsvp:{status}")
            undo = {"folder": result["moved_to"], "from": meta.get("from") or "",
                    "note": "RSVP reply already sent — only the email is restored"}
```

`email_himalaya` is already imported at the top of this file (line 16). The existing `except Exception` wrapper turns himalaya failures into a 502 for the card toast; the explicit `_bad` returns a 400 before any I/O for an invalid status.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests/test_inbox_router.py -v`
Expected: PASS (all).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/inbox/__init__.py backend/tests/test_inbox_router.py
git commit -m "feat(inbox): rsvp action branch (reply + read + move)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Inbox card RSVP chips (frontend)

**Files:**
- Modify: `frontend-overrides/js/inbox.js` (card render ~line 511; `doAction` ~line 567; `bindCard` ~line 533)

- [ ] **Step 1: Add the RSVP row to the card template**

In `frontend-overrides/js/inbox.js`, immediately after the `it.snippet` line (line 511) and before the `it.rec` chip block (line 512), insert an RSVP block that renders the event line + three buttons when `it.meta.calendar` is present:

```javascript
      (it.meta && it.meta.calendar
        ? `    <div class="inbox-cal" title="${esc(it.meta.calendar.location || '')}">` +
          `📅 ${esc(it.meta.calendar.startISO || '')}` +
          (it.meta.calendar.location ? ` · ${esc(it.meta.calendar.location)}` : '') +
          `</div>` +
          `    <div class="inbox-rsvp">` +
          `<button data-rsvp="accepted" class="inbox-btn inbox-rsvp-yes">Yes</button>` +
          `<button data-rsvp="tentative" class="inbox-btn inbox-rsvp-maybe">Maybe</button>` +
          `<button data-rsvp="declined" class="inbox-btn inbox-rsvp-no">No</button>` +
          `</div>` : '') +
```

- [ ] **Step 2: Extend `doAction` to carry an extra body (e.g. rsvp status)**

Change the `doAction` signature and request body (line 567 / line 573) to merge an optional `extra` object:

```javascript
  async function doAction(it, act, el, btn, until, extra) {
    btn.disabled = true;
    try {
      const r = await fetch(`${API}/api/items/action`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: it.source, id: it.id, action: act,
                               until, title: it.title, meta: it.meta || {},
                               ...(extra || {}) }),
      });
```

(Leave the rest of `doAction` unchanged.)

- [ ] **Step 3: Bind the RSVP buttons in `bindCard`**

In `bindCard` (after the `.inbox-btn` loop, ~line 542, before the rec-chip block), add:

```javascript
    el.querySelectorAll('.inbox-rsvp button').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        doAction(it, 'rsvp', el, btn, undefined, { rsvp: btn.dataset.rsvp });
      });
    });
```

- [ ] **Step 4: Add minimal styles**

Append to the `<style>` block in `frontend-overrides/js/inbox.js` (find the existing injected CSS string — search for `.inbox-btn {`) these rules:

```css
.inbox-cal { font-size: 12px; opacity: 0.75; margin: 4px 0 2px; }
.inbox-rsvp { display: flex; gap: 6px; margin-top: 4px; }
.inbox-rsvp-yes { color: #1a7f37; }
.inbox-rsvp-no { color: #b42318; }
```

- [ ] **Step 5: Verify in the browser**

Run: `cd /Users/admin/openclaw-workspace && ./scripts/sync-frontend.sh` (propagates the override into the served `frontend/` build — see Task 10).
Then hard-reload the workspace, open the Inbox tab on an account that has a pending invite, and confirm the 📅 line + Yes/Maybe/No buttons render on that card only. (StaticFiles serves per request — no backend restart needed for JS.)

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/inbox.js
git commit -m "feat(inbox-ui): RSVP chips on calendar-invite cards

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Email-tab RSVP menu items (frontend)

**Files:**
- Modify: `frontend-vendor/js/emailInbox.js` (`_showEmailMenu` ~line 925; add `_rsvpEmail` near `_archiveEmail` ~line 1074)

- [ ] **Step 1: Add RSVP items to the row actions menu**

In `frontend-vendor/js/emailInbox.js`, in `_showEmailMenu`, change the `actions` array (lines 925–930) to conditionally prepend RSVP entries when the row is an invite candidate:

```javascript
  const actions = [
    { label: 'Open', icon: _replyIcon, action: () => _openEmail(em, itemEl) },
    { label: 'Remind to reply', icon: _bellIcon, submenu: 'remind' },
    { label: 'Archive', icon: _archiveIcon, action: () => _archiveEmail(em) },
    { label: 'Delete', icon: _deleteIcon, danger: true, action: () => _deleteEmail(em) },
  ];
  if (em.is_invite_candidate) {
    actions.unshift(
      { label: 'RSVP: Yes', icon: _replyIcon, action: () => _rsvpEmail(em, 'accepted') },
      { label: 'RSVP: Maybe', icon: _replyIcon, action: () => _rsvpEmail(em, 'tentative') },
      { label: 'RSVP: No', icon: _replyIcon, action: () => _rsvpEmail(em, 'declined') },
    );
  }
```

- [ ] **Step 2: Add the `_rsvpEmail` handler (mirrors `_archiveEmail`)**

Add next to `_archiveEmail` (~line 1082):

```javascript
async function _rsvpEmail(em, status) {
  try {
    const res = await fetch(`${API_BASE}/api/email/rsvp/${em.uid}${_acct()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rsvp: status, folder: _currentFolder }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _emails = _emails.filter(e => e.uid !== em.uid);
    _renderList();
    import('./ui.js').then(m => m.showToast &&
      m.showToast(`RSVP sent (${status}) — moved to ${data.moved_to.includes('Trash') ? 'Trash' : 'Archive'}`,
                  { duration: 3000 })).catch(() => {});
  } catch (e) {
    console.error('RSVP failed:', e);
    import('./ui.js').then(m => m.showError &&
      m.showError('RSVP failed: ' + (e.message || e))).catch(() => {});
  }
}
```

(`_acct()`, `_currentFolder`, `_emails`, `_renderList`, `API_BASE` are all module-scoped in this file.)

- [ ] **Step 3: Verify in the browser**

Run: `cd /Users/admin/openclaw-workspace && ./scripts/sync-frontend.sh`
Hard-reload, open the Email tab, open the ⋯ menu on an invite row → confirm "RSVP: Yes/Maybe/No" appear only on invite rows; clicking sends and removes the row with a toast.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-vendor/js/emailInbox.js
git commit -m "feat(email-ui): RSVP menu items on invite rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Sync, restart, and live smoke

**Files:** none (operational).

- [ ] **Step 1: Full test suite**

Run: `cd /Users/admin/openclaw-workspace && python -m pytest backend/tests -q`
Expected: all pass (existing + new).

- [ ] **Step 2: Sync frontend overlay → served build**

Run: `cd /Users/admin/openclaw-workspace && ./scripts/sync-frontend.sh`
This regenerates the gitignored `frontend/` from `frontend-vendor/` + `frontend-overrides/`. Static JS needs no restart (uvicorn StaticFiles reads per request); the *backend* Python changes (Tasks 3–7) DO need a gateway restart.

- [ ] **Step 3: Restart the gateway for backend changes**

The host is a slow 2014 Mac mini — cold boots take minutes and stall under I/O (`[[project_hardware_constraint]]`). Restart once, then wait; do not repeat-kick.
Run: `launchctl kickstart -k gui/$(id -u)/<workspace-launchagent-label>`
(Find the label with `launchctl list | grep -i openclaw` if unknown.)

- [ ] **Step 4: Live smoke — Inbox Yes**

Send a real Google Calendar invite to the configured account. In the Inbox tab, on that card click **Yes** → verify: (a) the organizer's calendar shows you as Accepted, (b) the email is gone from INBOX (in All Mail), (c) it's marked read. Then test **No** on a second invite → verify it lands in Trash.

- [ ] **Step 5: Live smoke — Email tab No**

In the Email tab, on an invite row open ⋯ → **RSVP: No** → verify organizer sees Declined and the message is trashed + read.

- [ ] **Step 6: Smoke-test cleanup**

Undo any test RSVP from the inbox 🕒 history drawer (restores/un-archives the email — note the reply itself is already sent and cannot be unsent). Delete throwaway test invites.

---

## Notes for the implementer

- **Repo hygiene:** This repo sometimes has concurrent Claude sessions. NEVER `git add -A`; stage only the explicit paths listed per task (`[[project_openclaw_workspace_inbox]]`).
- **himalaya query gotcha** (not hit here, but adjacent): himalaya's variadic query swallows trailing flags — always put `-o json`/`-f` before any positional query. The RSVP path uses `message export`/`message send`/`flag add`/`message move`, none of which take a free-text query.
- **Undo limitation is by design:** the iCal REPLY email is sent immediately and cannot be recalled; undo only restores the source email to INBOX. The card toast/history note says so.
- **Recurring events:** the reply carries the master `UID` (+ `RECURRENCE-ID` if the invite had one). No per-occurrence picker (out of scope per spec).
