"""The Odysseus Email tab, backed by a real himalaya Gmail mailbox.

Replaces the triage-feed adapter that used to live on /api/email/* in inbox.py.
Maps himalaya's CLI output ⇄ the exact shapes emailInbox.js / emailLibrary.js /
document.js expect. Pure functions (mappers, MIME builder) are unit-tested; the
I/O paths are verified live against the mailbox.
"""
from __future__ import annotations

import asyncio
import email
import html as _html
import json
import os
import re
import tomllib
from datetime import datetime, timezone
from email.policy import default as _email_policy
from email.utils import parseaddr
from pathlib import Path

from fastapi import APIRouter, Body
from fastapi.responses import JSONResponse

from . import bridge, config, himalaya_cli
from .calendar_invite import parse_ics_calendar

router = APIRouter()

_HIMALAYA_CONFIG = Path(os.environ.get(
    "HIMALAYA_CONFIG", Path.home() / ".config" / "himalaya" / "config.toml"))


def _account_address() -> str:
    """The configured Gmail address (for the accounts list + From header).
    Read from the himalaya config so there's a single source of truth."""
    env = os.environ.get("WORKSPACE_EMAIL_ADDRESS")
    if env:
        return env
    try:
        cfg = tomllib.loads(_HIMALAYA_CONFIG.read_text())
        for acct in (cfg.get("accounts") or {}).values():
            if acct.get("default") and acct.get("email"):
                return acct["email"]
        # fall back to the first account with an email
        for acct in (cfg.get("accounts") or {}).values():
            if acct.get("email"):
                return acct["email"]
    except Exception:  # noqa: BLE001
        pass
    return ""


def _account_name() -> str:
    try:
        cfg = tomllib.loads(_HIMALAYA_CONFIG.read_text())
        for acct in (cfg.get("accounts") or {}).values():
            if acct.get("default"):
                return acct.get("display-name") or ""
    except Exception:  # noqa: BLE001
        pass
    return ""


ACCOUNT_ADDRESS = _account_address()
ACCOUNT_NAME = _account_name()


def _from_header() -> str:
    return f"{ACCOUNT_NAME} <{ACCOUNT_ADDRESS}>" if ACCOUNT_NAME else ACCOUNT_ADDRESS


@router.get("/api/email/accounts")
async def accounts():
    addr = ACCOUNT_ADDRESS
    return [{"account_id": "gmail", "address": addr, "name": addr, "default": True}]


# --- mappers (pure; unit-tested) ---------------------------------------------

def _norm_date(d: str) -> str:
    """himalaya emits "YYYY-MM-DD HH:MM+ZZ:ZZ"; JS `new Date()` wants the T."""
    d = d or ""
    return d.replace(" ", "T", 1) if " " in d else d


def _flag(flags, name) -> bool:
    return any(str(f).lower() == name.lower() for f in (flags or []))


_INVITE_SUBJECT_RE = re.compile(
    r"^\s*(updated invitation|invitation|canceled event|updated event)\s*:",
    re.I)


def is_invite_candidate(subject: str, has_attachment: bool,
                        from_addr: str = "") -> bool:
    """Cheap envelope-only guess that an email is a calendar invite, so the
    expensive .ics body read is bounded to likely candidates. Confirmed only by
    calendar_invite.extract_invite after a read."""
    if not has_attachment:
        return False
    return bool(_INVITE_SUBJECT_RE.match(subject or ""))


def envelope_to_email(env: dict) -> dict:
    """One himalaya envelope -> the list-row shape emailInbox.js renders."""
    frm = env.get("from") or {}
    addr = frm.get("addr") or frm.get("address") or ""
    name = frm.get("name") or addr
    flags = env.get("flags") or []
    return {
        "uid": str(env.get("id", "")),
        "subject": env.get("subject") or "(no subject)",
        "from_name": name,
        "from_address": addr,
        "sender": name,
        "snippet": env.get("snippet") or "",
        "date": _norm_date(env.get("date") or ""),
        "is_read": _flag(flags, "Seen"),
        "is_answered": _flag(flags, "Answered"),
        "is_spam_verdict": False,
        "has_attachments": bool(env.get("has_attachment")),
        "is_invite_candidate": is_invite_candidate(
            env.get("subject") or "", bool(env.get("has_attachment")),
            (frm.get("addr") or frm.get("address") or "")),
        "tags": [],
    }


# --- list --------------------------------------------------------------------

@router.get("/api/email/list")
async def email_list(folder: str = "INBOX", limit: int = 50,
                     offset: int = 0, filter: str = "all"):
    page = offset // max(1, limit) + 1
    args = ["envelope", "list", "-f", folder, "-s", str(limit), "-p", str(page)]
    try:
        data = await himalaya_cli.run_json(args)
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse({"emails": [], "total": 0, "error": str(exc)})
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    emails = [envelope_to_email(e) for e in envs]
    if (filter or "all").lower() == "unread":
        emails = [e for e in emails if not e["is_read"]]
    return {"emails": emails, "total": len(emails)}


# --- folders -----------------------------------------------------------------

def folders_from_himalaya(raw) -> list[str]:
    out = []
    for f in (raw or []):
        name = f.get("name") if isinstance(f, dict) else f
        if name:
            out.append(name)
    return out


@router.get("/api/email/folders")
async def email_folders():
    try:
        raw = await himalaya_cli.run_json(["folder", "list"])
    except himalaya_cli.HimalayaError as exc:
        return {"folders": ["INBOX"], "error": str(exc)}
    items = raw if isinstance(raw, list) else (raw.get("folders") or [])
    # The UI's sortedFolders()/folderDisplayName() already role-map Gmail names.
    return {"folders": folders_from_himalaya(items)}


# --- read (export full .eml + parse with the email stdlib) -------------------

def message_to_read(raw: bytes, uid: str = "") -> dict:
    """Parse a raw RFC-822 message into the read-view shape the UI expects."""
    msg = email.message_from_bytes(raw, policy=_email_policy)
    plain, body_html, calendar_raw = "", "", ""
    attachments = []
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        ctype = part.get_content_type()
        # Capture a calendar invite (text/calendar) for parsing whether it's
        # inline (method=REQUEST) or an invite.ics attachment — don't surface it
        # as a downloadable attachment.
        if ctype == "text/calendar":
            try:
                cal = part.get_content()
            except Exception:  # noqa: BLE001
                cal = part.get_payload(decode=True) or b""
            if isinstance(cal, bytes):
                cal = cal.decode("utf-8", "replace")
            if cal and not calendar_raw:
                calendar_raw = cal
            continue
        if part.get_content_disposition() == "attachment":
            payload = part.get_payload(decode=True) or b""
            attachments.append({
                "index": len(attachments),
                "filename": part.get_filename() or f"attachment-{len(attachments)}",
                "size": len(payload),
            })
            continue
        try:
            content = part.get_content()
        except Exception:  # noqa: BLE001
            content = ""
        if ctype == "text/plain" and not plain:
            plain = content
        elif ctype == "text/html" and not body_html:
            body_html = content
    if not body_html:
        body_html = f'<div style="white-space:pre-wrap;">{_html.escape(plain)}</div>'
    from_name, from_addr = parseaddr(msg.get("From", ""))
    return {
        "uid": uid,
        "subject": msg.get("Subject") or "(no subject)",
        "from_address": from_addr,
        "from_name": from_name or from_addr,
        "to": msg.get("To") or "",
        "cc": msg.get("Cc") or "",
        "date": msg.get("Date") or "",
        "body": body_html,
        "body_html": body_html,
        "snippet": (plain or "")[:200],
        "message_id": msg.get("Message-ID") or "",
        "references": msg.get("References") or "",
        "attachments": attachments,
        "calendar": parse_ics_calendar(calendar_raw) if calendar_raw else None,
    }


@router.get("/api/email/read/{uid}")
async def email_read(uid: str, folder: str = "INBOX", mark_seen: bool = True):
    try:
        # -F streams the full raw RFC-822 message to stdout (no file written).
        raw = await himalaya_cli.run_raw(
            ["message", "export", uid, "-F", "-f", folder])
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse({"error": str(exc)})
    if mark_seen:
        try:  # export doesn't set \Seen; honor the UI's mark_seen explicitly
            await himalaya_cli.run_raw(["flag", "add", uid, "Seen", "-f", folder])
        except himalaya_cli.HimalayaError:
            pass
    return message_to_read(raw, uid)


# --- flags -------------------------------------------------------------------

async def _flag_op(verb: str, uid: str, folder: str, flag_name: str):
    try:
        await himalaya_cli.run_raw(["flag", verb, uid, flag_name, "-f", folder])
        return {"ok": True}
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse(status_code=502, content={"ok": False, "error": str(exc)})


@router.post("/api/email/mark-read/{uid}")
async def mark_read(uid: str, folder: str = "INBOX"):
    return await _flag_op("add", uid, folder, "Seen")


@router.post("/api/email/mark-unread/{uid}")
async def mark_unread(uid: str, folder: str = "INBOX"):
    return await _flag_op("remove", uid, folder, "Seen")


@router.post("/api/email/mark-answered/{uid}")
async def mark_answered(uid: str, folder: str = "INBOX"):
    return await _flag_op("add", uid, folder, "Answered")


@router.post("/api/email/clear-answered/{uid}")
async def clear_answered(uid: str, folder: str = "INBOX"):
    return await _flag_op("remove", uid, folder, "Answered")


# --- move / archive / delete -------------------------------------------------

ARCHIVE_FOLDER = "[Gmail]/All Mail"
TRASH_FOLDER = "[Gmail]/Trash"


async def _move(uid: str, src: str, dest: str):
    try:
        # himalaya: message move <TARGET> <ID>... -f <SOURCE>
        await himalaya_cli.run_raw(["message", "move", dest, uid, "-f", src])
        return {"ok": True}
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse(status_code=502, content={"ok": False, "error": str(exc)})


async def move_message(uid: str, src: str, dest: str) -> None:
    """Like _move but RAISES HimalayaError instead of returning a JSONResponse.
    For callers (the inbox router) that need failures to propagate — the
    endpoint-shaped _move swallows errors into a 502 response object, which a
    plain `await` silently ignores."""
    await himalaya_cli.run_raw(["message", "move", dest, uid, "-f", src])


def search_query(subject: str, from_addr: str) -> str:
    """Build a himalaya envelope-list query. The query grammar supports only
    from/to/subject/body/date/flag (NO header search — verified v1.2.0), and
    list-output subjects may carry a trailing truncation ellipsis. Strip
    quotes + ellipsis; IMAP SEARCH is substring-based so a prefix matches."""
    subj = subject.replace('"', "").rstrip().rstrip("…").strip()[:80]
    q = f'subject "{subj}"'
    if from_addr:
        q += f' and from "{from_addr.replace(chr(34), "")}"'
    return q


async def find_uid(folder: str, subject: str, from_addr: str) -> str | None:
    """Resolve a message's uid IN `folder` (IMAP uids are per-folder, so the
    pre-move uid is useless after archive/delete). Returns the newest match.

    Uses run_raw with `-o json` placed BEFORE the query: himalaya's variadic
    query parser swallows trailing options, silently emitting nothing
    (verified live, v1.2.0) — run_json's appended `-o json` would vanish."""
    if not subject.replace('"', "").rstrip().rstrip("…").strip():
        return None  # empty subject => IMAP match-all; refuse to guess
    out = await himalaya_cli.run_raw(
        ["envelope", "list", "-f", folder, "-s", "10", "-o", "json",
         search_query(subject, from_addr)])
    try:
        data = json.loads(out.decode() or "null")
    except json.JSONDecodeError:
        return None
    envs = data if isinstance(data, list) else ((data or {}).get("envelopes") or [])
    return str(envs[0]["id"]) if envs else None


@router.post("/api/email/archive/{uid}")
async def archive(uid: str, folder: str = "INBOX"):
    return await _move(uid, folder, ARCHIVE_FOLDER)


@router.delete("/api/email/delete/{uid}")
async def delete(uid: str, folder: str = "INBOX"):
    return await _move(uid, folder, TRASH_FOLDER)


@router.post("/api/email/move/{uid}")
async def move(uid: str, folder: str = "INBOX", dest: str = "INBOX"):
    return await _move(uid, folder, dest)


# --- search ------------------------------------------------------------------

@router.get("/api/email/search")
async def email_search(folder: str = "INBOX", q: str = "", limit: int = 100):
    if not q.strip():
        return {"emails": [], "total": 0}
    # himalaya's [QUERY]... is variadic and swallows trailing flags, so -o json
    # MUST come before the query. run_raw (not run_json, which appends -o json).
    try:
        out = await himalaya_cli.run_raw(
            ["envelope", "list", "-o", "json", "-f", folder, "-s", str(limit), q])
        data = json.loads(out.decode() or "null")
    except Exception as exc:  # noqa: BLE001
        return JSONResponse({"emails": [], "total": 0, "error": str(exc)})
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    return {"emails": [envelope_to_email(e) for e in envs], "total": len(envs)}


# --- send (compose / reply / forward all post here) --------------------------

def build_mime(*, from_addr: str, to: str, cc, bcc, subject: str, body: str,
               body_html, in_reply_to, references) -> bytes:
    """Assemble an RFC-822 message (text + optional HTML alt + threading hdrs)."""
    m = email.message.EmailMessage()
    m["From"] = from_addr
    m["To"] = to
    if cc:
        m["Cc"] = cc
    if bcc:
        m["Bcc"] = bcc
    m["Subject"] = subject or ""
    if in_reply_to:
        m["In-Reply-To"] = in_reply_to
    if references:
        m["References"] = references
    m.set_content(body or "")
    if body_html:
        m.add_alternative(body_html, subtype="html")
    return m.as_bytes()


@router.post("/api/email/send")
async def email_send(payload: dict = Body(...)):
    raw = build_mime(
        from_addr=_from_header(),
        to=payload.get("to") or "", cc=payload.get("cc"), bcc=payload.get("bcc"),
        subject=payload.get("subject") or "", body=payload.get("body") or "",
        body_html=payload.get("body_html"),
        in_reply_to=payload.get("in_reply_to"),
        references=payload.get("references"),
    )
    try:
        await himalaya_cli.run_raw(["message", "send"], stdin=raw)
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})
    return {"ok": True, "sent": True}


# --- draft: save a composed message into Gmail Drafts (no send) ---------------

DRAFTS_FOLDER = "[Gmail]/Drafts"
# This 2014 host is slow + its IMAP TLS handshake to Gmail blips under load
# (observed "cannot connect to TLS stream" that succeeds on retry), so mailbox
# writes get a longer budget and one retry. See [[project_hardware_constraint]].
_MAILBOX_TIMEOUT = 75.0


async def _himalaya_with_retry(args, *, stdin=None, attempts=2):
    last = None
    for i in range(attempts):
        try:
            return await himalaya_cli.run_raw(args, stdin=stdin,
                                              timeout=_MAILBOX_TIMEOUT)
        except himalaya_cli.HimalayaError as exc:
            last = exc
            if i + 1 < attempts:
                await asyncio.sleep(2)
    raise last


@router.post("/api/email/draft")
async def save_draft(payload: dict = Body(default=None)):
    """Append a composed message to the Drafts folder via IMAP (no send).

    Same MIME builder as /send; the frontend's #doc-email-draft-btn reads only
    {success, error}."""
    payload = payload or {}
    raw = build_mime(
        from_addr=_from_header(),
        to=payload.get("to") or "", cc=payload.get("cc"), bcc=payload.get("bcc"),
        subject=payload.get("subject") or "", body=payload.get("body") or "",
        body_html=payload.get("body_html"),
        in_reply_to=payload.get("in_reply_to"),
        references=payload.get("references"),
    )
    try:
        await _himalaya_with_retry(
            ["message", "save", "-f", DRAFTS_FOLDER], stdin=raw)
    except himalaya_cli.HimalayaError as exc:
        return {"success": False, "error": str(exc)}
    return {"success": True}


# --- writing style: stored preference + brain extraction from sent mail -------

_STYLE_FILE = config.DATA_DIR / "email_style.json"
SENT_FOLDER = "[Gmail]/Sent Mail"
_STYLE_MAX_SAMPLES = 5  # cap himalaya reads — each is a slow subprocess on this host
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_tags(s: str) -> str:
    """Crude HTML→text: drop tags, unescape entities, collapse whitespace.
    Normalizes non-breaking/zero-width spaces (common in HTML mail) first so the
    horizontal-whitespace collapse actually catches them."""
    txt = _html.unescape(_TAG_RE.sub(" ", s or "")).replace("\xa0", " ").replace("​", "")
    return re.sub(r"[ \t]+", " ", txt).strip()


def _message_plain(raw: bytes) -> str:
    """Best-effort plain text of a raw message (text/plain, else stripped HTML)."""
    msg = email.message_from_bytes(raw, policy=_email_policy)
    plain, html_body = "", ""
    for part in msg.walk():
        if part.get_content_maintype() == "multipart":
            continue
        if part.get_content_disposition() == "attachment":
            continue
        try:
            content = part.get_content()
        except Exception:  # noqa: BLE001
            content = ""
        ctype = part.get_content_type()
        if ctype == "text/plain" and not plain:
            plain = content
        elif ctype == "text/html" and not html_body:
            html_body = content
    return plain.strip() or _strip_tags(html_body)


def _load_style() -> str:
    try:
        return (json.loads(_STYLE_FILE.read_text()).get("style") or "").strip()
    except Exception:  # noqa: BLE001 - absent/corrupt → no style
        return ""


def _save_style(style: str) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = _STYLE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"style": style or ""}))
    tmp.replace(_STYLE_FILE)  # atomic


def _style_extract_prompt(samples: list[str]) -> str:
    joined = "\n\n--- next email ---\n\n".join(samples)
    return (
        "Below are several emails I have written. Analyze MY writing style and "
        "produce a concise, reusable style guide (tone, greeting + sign-off "
        "habits, formality, typical sentence length, recurring phrases or "
        "quirks) that another writer could follow to sound like me. Output ONLY "
        "the guide as short bullet points — no preamble.\n\n" + joined)


@router.get("/api/email/style")
async def get_style():
    return {"style": _load_style()}


@router.put("/api/email/style")
async def put_style(payload: dict = Body(default=None)):
    _save_style((payload or {}).get("style") or "")
    return {"success": True}


async def _recent_sent_bodies(n: int) -> list[str]:
    """Plain-text bodies of the most recent sent messages (best-effort)."""
    try:
        data = await himalaya_cli.run_json(
            ["envelope", "list", "-f", SENT_FOLDER, "-s", str(n)],
            timeout=_MAILBOX_TIMEOUT)
    except himalaya_cli.HimalayaError:
        return []
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    bodies: list[str] = []
    for env in envs[:n]:
        uid = str(env.get("id") or env.get("uid") or "").strip()
        if not uid:
            continue
        try:
            raw = await _himalaya_with_retry(
                ["message", "export", uid, "-F", "-f", SENT_FOLDER])
        except himalaya_cli.HimalayaError:
            continue
        text = _message_plain(raw)
        if text:
            bodies.append(text[:800])
    return bodies


@router.post("/api/email/extract-style")
async def extract_style(payload: dict = Body(default=None)):
    """Infer the user's writing style from recent sent mail (one brain turn)."""
    want = int((payload or {}).get("sample_count") or 15)
    n = max(1, min(want, _STYLE_MAX_SAMPLES))
    bodies = await _recent_sent_bodies(n)
    if not bodies:
        return {"success": False,
                "error": "No sent emails found to analyze."}
    try:
        style = await _brain_once(_style_extract_prompt(bodies))
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{exc!r}"}
    if not style:
        return {"success": False,
                "error": "The brain returned no text — try again in a moment."}
    return {"success": True, "style": style}


# --- summarize: condense an email with the OpenClaw brain --------------------

def _summary_prompt(subject: str, frm: str, body: str) -> str:
    return (
        "Summarize this email in 2-4 short sentences (or tight bullets). Capture "
        "the key point and any action or ask. Output ONLY the summary.\n\n"
        f"From: {frm}\nSubject: {subject}\n\n{body[:4000]}")


@router.post("/api/email/summarize")
async def summarize(payload: dict = Body(default=None)):
    payload = payload or {}
    body = _strip_tags(payload.get("body") or "")
    if not body:
        return {"success": False, "error": "Nothing to summarize."}
    prompt = _summary_prompt(payload.get("subject") or "",
                             payload.get("from") or "", body)
    try:
        summary = await _brain_once(prompt)
    except Exception as exc:  # noqa: BLE001
        return {"success": False, "error": f"{exc!r}"}
    if not summary:
        return {"success": False,
                "error": "AI summary unavailable — the brain returned no text "
                         "(try again in a moment)."}
    return {"success": True, "summary": summary}


# --- AI-reply: draft a reply with the OpenClaw brain -------------------------

async def _brain_once(prompt: str) -> str:
    """Run one turn on the shared web session via the bridge; return its text."""
    chunks: list[str] = []
    async for sse in bridge.stream_turn(prompt, session_key=config.web_session_key()):
        if not sse.startswith("data:"):
            continue
        line = sse[5:].strip()
        if not line or line == "[DONE]":
            continue
        try:
            obj = json.loads(line)
        except Exception:  # noqa: BLE001
            continue
        if isinstance(obj, dict) and obj.get("delta"):
            chunks.append(obj["delta"])
    return "".join(chunks).strip()


@router.post("/api/email/ai-reply")
async def ai_reply(payload: dict = Body(default=None)):
    payload = payload or {}
    subj = payload.get("subject") or ""
    frm = payload.get("from_address") or ""
    orig = (payload.get("original_body") or payload.get("body") or "")[:4000]
    style = _load_style()
    style_block = f"\n\nWrite in MY style:\n{style}" if style else ""
    prompt = ("Draft a concise, friendly reply to this email. Output ONLY the "
              f"reply body — no preamble, no subject line.{style_block}\n\n"
              f"From: {frm}\nSubject: {subj}\n\n{orig}")
    try:
        reply = await _brain_once(prompt)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"error": f"{exc!r}"})
    if not reply:
        # Brain produced an empty turn (codex stall / throttle). Don't hand the
        # composer a blank draft — surface it so the UI shows a real message.
        return JSONResponse(status_code=503,
                            content={"error": "AI draft unavailable — the brain "
                                     "returned no text (try again in a moment)."})
    return {"reply": reply, "cached_ai_reply": reply}


# --- stubs: rich-UI endpoints himalaya/this deployment has no primitive for ---
# (Declared so the email modules never error; literal paths before any {uid}.)

@router.get("/api/email/urgency-state")
async def urgency_state():
    return {"per_uid": {}}


@router.get("/api/email/scheduled")
async def scheduled():
    return []


@router.delete("/api/email/scheduled/{sid}")
async def scheduled_delete(sid: str):
    return {"ok": True}


@router.get("/api/email/odysseus/reminders")
async def reminders():
    return []


@router.get("/api/email/contacts")
async def contacts():
    return {"contacts": []}


@router.post("/api/email/{uid}/unflag-spam")
async def unflag_spam(uid: str, folder: str = "INBOX"):
    return {"ok": True}
