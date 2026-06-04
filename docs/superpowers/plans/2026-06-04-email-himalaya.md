# Email tab → himalaya Gmail mailbox — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Odysseus Email tab a real Gmail IMAP/SMTP client backed by `himalaya`, replacing the triage-feed adapter on `/api/email/*`.

**Architecture:** A thin subprocess wrapper (`himalaya_cli.py`) runs `himalaya … -o json` per request; a FastAPI router (`email_himalaya.py`) maps himalaya's JSON ⇄ the exact shapes the frontend (`emailInbox.js`, `emailLibrary.js`, `document.js`) already expects. Pure functions (envelope/message mappers, MIME builder, folder roles) are unit-tested with pytest; the I/O paths are verified live against the real mailbox (read tests on the inbox; send/move tested on self-sent throwaway mail).

**Tech Stack:** Python 3.14, FastAPI, `himalaya` CLI (brew), macOS keychain for the credential, pytest (new), `email`/`email.mime` stdlib for MIME.

**Spec:** `docs/superpowers/specs/2026-06-04-email-himalaya-design.md`

---

## File Structure

- Create `backend/himalaya_cli.py` — subprocess runner + typed wrappers over himalaya subcommands (envelopes, read, send, flag, move, delete, folders, search, attachment). One responsibility: talk to the himalaya binary, return parsed JSON / raw bytes, normalize errors.
- Create `backend/email_himalaya.py` — the `/api/email/*` FastAPI router + pure mapping functions (envelope→email, message→read-shape, folder→role) + MIME builder + brain ai-reply. One responsibility: present himalaya as the Odysseus email API.
- Create `backend/tests/__init__.py`, `backend/tests/test_email_himalaya.py` — pytest for the pure functions.
- Modify `backend/inbox.py` — remove the 10 `/api/email/*` routes (keep only `/api/items` + its helpers).
- Modify `backend/app.py` — include `email_himalaya.router`; drop nothing else (inbox_router still included for `/api/items`).
- Modify `backend/requirements.txt` — add `pytest`.
- Config (not in repo): `~/.config/himalaya/config.toml`, a macOS keychain entry, and `skills.entries.himalaya.enabled=true` in `~/.openclaw/openclaw.json`.

---

## Task 1: Install himalaya, configure Gmail, and probe the JSON shapes

**Files:** none in repo (system setup + a scratch probe file at `/tmp/himalaya-probe.txt`).

- [ ] **Step 1: Install himalaya**

Run: `brew install himalaya && himalaya --version`
Expected: prints a version (note it — the rest of this task confirms subcommand syntax against it, since flags shifted across 0.x/1.x).

- [ ] **Step 2: Store the Gmail App Password in the macOS keychain**

The user generates a Google App Password (Account → Security → App passwords → "himalaya"). Then THEY run (so it never enters an agent transcript; suggest they type it with a leading `! `):

```bash
security add-generic-password -U -a "<gmail-address>" -s "himalaya-gmail" -w "<app-password>"
```
Verify (returns the password to stdout — run only to confirm it's stored):
`security find-generic-password -a "<gmail-address>" -s "himalaya-gmail" -w` → prints the password.

- [ ] **Step 3: Write `~/.config/himalaya/config.toml`**

```toml
[accounts.gmail]
default = true
email = "<gmail-address>"
display-name = "<display name>"

backend.type = "imap"
backend.host = "imap.gmail.com"
backend.port = 993
backend.encryption.type = "tls"
backend.login = "<gmail-address>"
backend.auth.type = "password"
backend.auth.command = "security find-generic-password -a '<gmail-address>' -s 'himalaya-gmail' -w"

message.send.backend.type = "smtp"
message.send.backend.host = "smtp.gmail.com"
message.send.backend.port = 465
message.send.backend.encryption.type = "tls"
message.send.backend.login = "<gmail-address>"
message.send.backend.auth.type = "password"
message.send.backend.auth.command = "security find-generic-password -a '<gmail-address>' -s 'himalaya-gmail' -w"
```

NOTE: key names (`backend.auth.command` vs `passwd.cmd`) differ by himalaya version — reconcile against `himalaya account configure --help` / the version's docs. The intent is fixed: IMAP+SMTP over TLS, password sourced from the keychain command.

- [ ] **Step 4: Verify himalaya connects and capture the real JSON shapes**

```bash
himalaya folder list -o json            | tee -a /tmp/himalaya-probe.txt
himalaya envelope list -f INBOX -o json | head -c 2000 | tee -a /tmp/himalaya-probe.txt
# pick an ID from the envelope output, then:
himalaya message read <ID> -f INBOX -o json | head -c 2000 | tee -a /tmp/himalaya-probe.txt
himalaya envelope list --help; himalaya message send --help; himalaya flag --help; himalaya message move --help
```
Expected: real JSON. **Record the exact field names** (envelope: id, flags, subject, from{name,addr}, date, …; message read: body/parts, headers). Tasks 3/5/9 map these — reconcile their code against this probe output.

- [ ] **Step 5: Enable the himalaya OpenClaw skill**

Edit `~/.openclaw/openclaw.json`: set `skills.entries.himalaya.enabled = true`. (Lets the agent use himalaya too; does not affect the web app.)

- [ ] **Step 6: Commit (config note only — secrets are NOT committed)**

```bash
cd ~/openclaw-workspace
# nothing to commit yet; config lives outside the repo. Proceed.
```

---

## Task 2: Scaffold the himalaya runner + router, wire into app, remove inbox's email routes

**Files:**
- Create: `backend/himalaya_cli.py`
- Create: `backend/email_himalaya.py`
- Create: `backend/tests/__init__.py`, `backend/tests/test_email_himalaya.py`
- Modify: `backend/requirements.txt`, `backend/app.py`, `backend/inbox.py`

- [ ] **Step 1: Add pytest to requirements and install**

Edit `backend/requirements.txt`, append `pytest`. Run: `cd ~/openclaw-workspace && .venv/bin/pip install pytest`
Expected: pytest installs.

- [ ] **Step 2: Write the himalaya runner**

Create `backend/himalaya_cli.py`:

```python
"""Thin subprocess wrapper over the himalaya CLI. One job: run himalaya with an
arg list, return parsed JSON (or raw bytes), normalize failures into HimalayaError.
Stateless — a fresh process per call (same pattern as the other adapters)."""
from __future__ import annotations

import asyncio
import json


class HimalayaError(RuntimeError):
    pass


async def run_json(args: list[str], *, stdin: bytes | None = None, timeout: float = 30) -> object:
    """Run `himalaya <args> -o json` and return the decoded JSON."""
    out = await run_raw([*args, "-o", "json"], stdin=stdin, timeout=timeout)
    try:
        return json.loads(out.decode() or "null")
    except json.JSONDecodeError as exc:
        raise HimalayaError(f"himalaya gave non-JSON output: {out[:200]!r}") from exc


async def run_raw(args: list[str], *, stdin: bytes | None = None, timeout: float = 30) -> bytes:
    proc = await asyncio.create_subprocess_exec(
        "himalaya", *args,
        stdin=asyncio.subprocess.PIPE if stdin is not None else None,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin), timeout=timeout)
    except asyncio.TimeoutError as exc:
        proc.kill()
        raise HimalayaError(f"himalaya {args[:2]} timed out") from exc
    if proc.returncode != 0:
        tail = (err or b"").decode(errors="replace")[-400:]
        raise HimalayaError(f"himalaya {args[:2]} failed: {tail}")
    return out or b""
```

- [ ] **Step 3: Write the router skeleton with `/api/email/accounts`**

Create `backend/email_himalaya.py`:

```python
"""The Odysseus Email tab, backed by a real himalaya Gmail mailbox.
Replaces the triage-feed adapter that used to live on /api/email/* in inbox.py."""
from __future__ import annotations

import os

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import himalaya_cli

router = APIRouter()

# The single configured account. Address is read from env or the himalaya config
# default; kept here so the accounts endpoint and "from" header agree.
ACCOUNT_ADDRESS = os.environ.get("WORKSPACE_EMAIL_ADDRESS", "")


@router.get("/api/email/accounts")
async def accounts():
    addr = ACCOUNT_ADDRESS
    return [{"account_id": "gmail", "address": addr, "name": addr, "default": True}]
```

- [ ] **Step 4: Wire the router into app.py and remove inbox's email routes**

In `backend/app.py`, add import + include (next to the others):
```python
from .email_himalaya import router as email_router
app.include_router(email_router)
```
In `backend/inbox.py`, DELETE all 10 `@router.<verb>("/api/email/…")` route functions and the helpers used only by them (`_encode_uid`, `_decode_uid`, `_to_email`, `_mapped_emails`, `_item_by_uid`, `_SOURCE_LABELS`, `_iso`, `_source_action`). KEEP `_fetch_feed`, `items()` (`/api/email/list`? no) — keep only `/api/items` and what it needs. Verify nothing else imports the deleted names: `grep -rn "_to_email\|_encode_uid" backend/`.

- [ ] **Step 5: Verify the app boots and accounts works**

Run: restart the service `launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace`, wait for bind, then
`curl -s localhost:8800/api/email/accounts`
Expected: `[{"account_id":"gmail","address":"…","name":"…","default":true}]`. And `curl -s localhost:8800/api/items` still returns the triage feed (regression check).

- [ ] **Step 6: Commit**

```bash
git add backend/himalaya_cli.py backend/email_himalaya.py backend/app.py backend/inbox.py backend/requirements.txt backend/tests/
git commit -m "feat(email): scaffold himalaya runner + email router; drop triage email adapter"
```

---

## Task 3: List — envelope→email mapper + `GET /api/email/list`

**Files:** Modify `backend/email_himalaya.py`, `backend/tests/test_email_himalaya.py`

- [ ] **Step 1: Write the failing test for the mapper**

In `backend/tests/test_email_himalaya.py`:
```python
from backend.email_himalaya import envelope_to_email

def test_envelope_to_email_basic():
    env = {"id": "42", "flags": ["Seen"], "subject": "Hi",
           "from": {"name": "Jane Doe", "addr": "jane@x.com"},
           "date": "2026-06-04T12:00:00-04:00", "has_attachment": True}
    e = envelope_to_email(env)
    assert e["uid"] == "42"
    assert e["subject"] == "Hi"
    assert e["from_name"] == "Jane Doe"
    assert e["from_address"] == "jane@x.com"
    assert e["is_read"] is True
    assert e["has_attachments"] is True
    assert e["is_answered"] is False
    assert e["tags"] == []

def test_envelope_to_email_unseen_unanswered():
    e = envelope_to_email({"id": "7", "flags": [], "subject": "", "from": {"addr": "a@b.c"}, "date": ""})
    assert e["is_read"] is False
    assert e["from_name"] == "a@b.c"   # falls back to address
```

- [ ] **Step 2: Run it to verify failure**

Run: `cd ~/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_email_himalaya.py -q`
Expected: FAIL (ImportError: cannot import name 'envelope_to_email').

- [ ] **Step 3: Implement the mapper** (reconcile field names with Task 1 probe)

Add to `backend/email_himalaya.py`:
```python
def _flag(flags, name):
    return any(str(f).lower() == name.lower() for f in (flags or []))

def envelope_to_email(env: dict) -> dict:
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
        "date": env.get("date") or "",
        "is_read": _flag(flags, "Seen"),
        "is_answered": _flag(flags, "Answered"),
        "is_spam_verdict": False,
        "has_attachments": bool(env.get("has_attachment")),
        "tags": [],
    }
```

- [ ] **Step 4: Run the test to verify pass**

Run: `.venv/bin/python -m pytest backend/tests/test_email_himalaya.py -q`
Expected: PASS.

- [ ] **Step 5: Add the list route**

Add to `backend/email_himalaya.py`:
```python
from fastapi import Request

@router.get("/api/email/list")
async def email_list(request: Request, folder: str = "INBOX",
                     limit: int = 50, offset: int = 0, filter: str = "all"):
    args = ["envelope", "list", "-f", folder, "-s", str(limit), "-p",
            str(offset // max(1, limit) + 1)]
    # filter=unread → only unseen (IMAP search); else all.
    try:
        data = await himalaya_cli.run_json(args)
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse({"emails": [], "total": 0, "error": str(exc)})
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    emails = [envelope_to_email(e) for e in envs]
    if (filter or "all").lower() == "unread":
        emails = [e for e in emails if not e["is_read"]]
    return {"emails": emails, "total": len(emails)}
```
NOTE: himalaya paginates by page (`-p`) + page size (`-s`); the Odysseus UI passes `offset`. Convert as above; confirm `-s`/`-p` flag names against Task 1's `envelope list --help`.

- [ ] **Step 6: Verify live**

Run: restart service, `curl -s 'localhost:8800/api/email/list?folder=INBOX&limit=5' | python3 -m json.tool | head -40`
Expected: 5 real messages from your inbox, with `subject/from_name/is_read`.

- [ ] **Step 7: Commit**

```bash
git add backend/email_himalaya.py backend/tests/test_email_himalaya.py
git commit -m "feat(email): list inbox via himalaya envelopes"
```

---

## Task 4: Folders + role mapping + `GET /api/email/folders`

**Files:** Modify `backend/email_himalaya.py`, `backend/tests/test_email_himalaya.py`

- [ ] **Step 1: Failing test for folder extraction**

```python
from backend.email_himalaya import folders_from_himalaya

def test_folders_from_himalaya_list_of_dicts():
    raw = [{"name": "INBOX"}, {"name": "[Gmail]/Sent Mail"}, {"name": "[Gmail]/Trash"}]
    assert folders_from_himalaya(raw) == ["INBOX", "[Gmail]/Sent Mail", "[Gmail]/Trash"]

def test_folders_from_himalaya_list_of_strings():
    assert folders_from_himalaya(["INBOX", "Work"]) == ["INBOX", "Work"]
```

- [ ] **Step 2: Run → FAIL.** `.venv/bin/python -m pytest backend/tests -q` (ImportError).

- [ ] **Step 3: Implement**

```python
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
    return {"folders": folders_from_himalaya(items)}
```
NOTE: the UI's `sortedFolders()`/`folderDisplayName()` already role-map Gmail names (`[Gmail]/Sent Mail` → "Sent" etc.), so we pass raw names through.

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Verify live.** `curl -s localhost:8800/api/email/folders` → `{"folders":["INBOX","[Gmail]/All Mail","[Gmail]/Sent Mail", …]}`.

- [ ] **Step 6: Commit.** `git commit -am "feat(email): real Gmail folders"`

---

## Task 5: Read — message→read-shape mapper + `GET /api/email/read/{uid}`

**Files:** Modify `backend/email_himalaya.py`, `backend/tests/test_email_himalaya.py`

- [ ] **Step 1: Failing test for the read mapper**

```python
from backend.email_himalaya import message_to_read

def test_message_to_read_minimal():
    msg = {"id": "42", "subject": "Hi", "from": {"name": "Jane", "addr": "jane@x.com"},
           "to": [{"addr": "me@x.com"}], "date": "2026-06-04T12:00:00-04:00",
           "body": {"plain": "hello\nthere"}, "message_id": "<abc@x>",
           "attachments": [{"filename": "a.pdf", "size": 10}]}
    r = message_to_read(msg)
    assert r["subject"] == "Hi"
    assert r["from_address"] == "jane@x.com"
    assert "hello" in r["body"]
    assert r["message_id"] == "<abc@x>"
    assert r["attachments"][0]["filename"] == "a.pdf"
    assert r["attachments"][0]["index"] == 0
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement** (reconcile body/attachment field names with Task 1 probe — himalaya may return the raw RFC822 in `message`/`raw` instead of `body.plain`; if so, parse with `email.message_from_bytes`)

```python
import html as _html

def message_to_read(msg: dict) -> dict:
    frm = msg.get("from") or {}
    body = msg.get("body") or {}
    plain = body.get("plain") if isinstance(body, dict) else None
    htmlbody = body.get("html") if isinstance(body, dict) else None
    if plain is None and isinstance(msg.get("body"), str):
        plain = msg["body"]
    text = plain or ""
    body_html = htmlbody or f'<div style="white-space:pre-wrap;">{_html.escape(text)}</div>'
    atts = []
    for i, a in enumerate(msg.get("attachments") or []):
        atts.append({"index": i, "filename": a.get("filename") or f"attachment-{i}",
                     "size": a.get("size") or 0})
    return {
        "subject": msg.get("subject") or "(no subject)",
        "from_address": frm.get("addr") or frm.get("address") or "",
        "from_name": frm.get("name") or "",
        "to": msg.get("to") or [],
        "cc": msg.get("cc") or [],
        "date": msg.get("date") or "",
        "body": body_html,
        "body_html": body_html,
        "snippet": text[:200],
        "message_id": msg.get("message_id") or "",
        "references": msg.get("references") or "",
        "attachments": atts,
    }

@router.get("/api/email/read/{uid}")
async def email_read(uid: str, folder: str = "INBOX", mark_seen: bool = True):
    flags = [] if mark_seen else ["-p"]   # himalaya: --preview/-p reads without setting \Seen
    try:
        msg = await himalaya_cli.run_json(["message", "read", uid, "-f", folder, *flags])
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse({"error": str(exc)})
    return message_to_read(msg if isinstance(msg, dict) else {"body": str(msg)})
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Verify live.** Take a uid from `/api/email/list`, then
`curl -s 'localhost:8800/api/email/read/<uid>?folder=INBOX' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['subject']); print(d['body'][:200])"`
Expected: the real subject + body. If body is empty, the probe showed a different field — adjust `message_to_read` (likely parse `email.message_from_string`).

- [ ] **Step 6: Commit.** `git commit -am "feat(email): read full message bodies"`

---

## Task 6: Flags — mark read/unread/answered/clear-answered

**Files:** Modify `backend/email_himalaya.py`

- [ ] **Step 1: Implement the four flag routes**

```python
from fastapi import Form

async def _flag_op(verb: str, uid: str, folder: str, flag: str):
    try:
        await himalaya_cli.run_raw(["flag", verb, uid, flag, "-f", folder])
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
```
NOTE: confirm `flag add <id> <FLAG>` arg order against Task 1's `himalaya flag --help`.

- [ ] **Step 2: Verify live (on a throwaway self-sent message after Task 9, or any inbox item — toggling Seen is safe/reversible)**

`curl -s -X POST 'localhost:8800/api/email/mark-unread/<uid>?folder=INBOX'` → `{"ok":true}`; confirm in `/api/email/list` the item flips `is_read:false`, then mark-read to restore.

- [ ] **Step 3: Commit.** `git commit -am "feat(email): seen/answered flag ops"`

---

## Task 7: Move ops — archive / delete / move

**Files:** Modify `backend/email_himalaya.py`

- [ ] **Step 1: Implement**

```python
ARCHIVE_FOLDER = "[Gmail]/All Mail"
TRASH_FOLDER = "[Gmail]/Trash"

async def _move(uid: str, src: str, dest: str):
    try:
        await himalaya_cli.run_raw(["message", "move", uid, dest, "-f", src])
        return {"ok": True}
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse(status_code=502, content={"ok": False, "error": str(exc)})

@router.post("/api/email/archive/{uid}")
async def archive(uid: str, folder: str = "INBOX"):
    return await _move(uid, folder, ARCHIVE_FOLDER)

@router.delete("/api/email/delete/{uid}")
async def delete(uid: str, folder: str = "INBOX"):
    return await _move(uid, folder, TRASH_FOLDER)

@router.post("/api/email/move/{uid}")
async def move(uid: str, folder: str = "INBOX", dest: str = "INBOX"):
    return await _move(uid, folder, dest)
```
NOTE: Gmail "archive" = remove from INBOX; moving INBOX→All Mail achieves that. Confirm `message move <id> <target> -f <source>` arg order against the probe.

- [ ] **Step 2: Verify live on a throwaway** (after Task 9 self-send exists): archive it, confirm it leaves INBOX in `/api/email/list`, find it under `?folder=[Gmail]/All Mail`.

- [ ] **Step 3: Commit.** `git commit -am "feat(email): archive/delete/move"`

---

## Task 8: Search — `GET /api/email/search`

**Files:** Modify `backend/email_himalaya.py`

- [ ] **Step 1: Implement**

```python
@router.get("/api/email/search")
async def email_search(folder: str = "INBOX", q: str = "", limit: int = 100):
    if not q.strip():
        return {"emails": [], "total": 0}
    try:
        data = await himalaya_cli.run_json(
            ["envelope", "list", "-f", folder, "-s", str(limit), q])
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse({"emails": [], "total": 0, "error": str(exc)})
    envs = data if isinstance(data, list) else (data.get("envelopes") or [])
    emails = [envelope_to_email(e) for e in envs]
    return {"emails": emails, "total": len(emails)}
```
NOTE: himalaya envelope list accepts an IMAP-ish query as a trailing arg; confirm the query grammar (`subject "x"`, `from y`) against the probe and pass `q` through.

- [ ] **Step 2: Verify live.** `curl -s 'localhost:8800/api/email/search?folder=INBOX&q=subject%20test'` → matching messages.

- [ ] **Step 3: Commit.** `git commit -am "feat(email): search"`

---

## Task 9: Send — MIME builder + `POST /api/email/send`

**Files:** Modify `backend/email_himalaya.py`, `backend/tests/test_email_himalaya.py`

- [ ] **Step 1: Failing test for the MIME builder**

```python
from backend.email_himalaya import build_mime

def test_build_mime_basic():
    raw = build_mime(from_addr="me@x.com", to="a@b.com", cc=None, bcc=None,
                     subject="Hi", body="hello", body_html=None,
                     in_reply_to=None, references=None)
    s = raw.decode()
    assert "To: a@b.com" in s
    assert "Subject: Hi" in s
    assert "hello" in s
    assert "From: me@x.com" in s

def test_build_mime_threading_headers():
    raw = build_mime(from_addr="me@x.com", to="a@b.com", cc=None, bcc=None,
                     subject="Re: Hi", body="ok", body_html=None,
                     in_reply_to="<abc@x>", references="<abc@x>").decode()
    assert "In-Reply-To: <abc@x>" in raw
    assert "References: <abc@x>" in raw
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Implement the builder**

```python
from email.message import EmailMessage

def build_mime(*, from_addr, to, cc, bcc, subject, body, body_html,
               in_reply_to, references) -> bytes:
    m = EmailMessage()
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
```

- [ ] **Step 4: Run → PASS.**

- [ ] **Step 5: Add the send route**

```python
from fastapi import Body

@router.post("/api/email/send")
async def email_send(payload: dict = Body(...)):
    raw = build_mime(
        from_addr=ACCOUNT_ADDRESS,
        to=payload.get("to") or "", cc=payload.get("cc"), bcc=payload.get("bcc"),
        subject=payload.get("subject") or "", body=payload.get("body") or "",
        body_html=payload.get("body_html"),
        in_reply_to=payload.get("in_reply_to"), references=payload.get("references"),
    )
    try:
        await himalaya_cli.run_raw(["message", "send"], stdin=raw)
    except himalaya_cli.HimalayaError as exc:
        return JSONResponse(status_code=502, content={"error": str(exc)})
    return {"ok": True, "sent": True}
```
NOTE: confirm `message send` reads raw MIME from stdin (vs `message send -- <file>`); adjust if the probe shows otherwise.

- [ ] **Step 6: Verify live by emailing yourself**

`curl -s -X POST localhost:8800/api/email/send -H 'Content-Type: application/json' -d '{"to":"<your-gmail>","subject":"himalaya selftest","body":"hello from the workspace"}'`
Expected: `{"ok":true,"sent":true}` and the mail arrives in your inbox within a minute.

- [ ] **Step 7: Commit.** `git commit -am "feat(email): compose + send via himalaya SMTP"`

---

## Task 10: Reply threading verification (no new code)

**Files:** none (verification of Task 5 + Task 9 together).

- [ ] **Step 1: Self-thread test**

Read the self-test message (`/api/email/read/<uid>`) → capture its `message_id`. Send a reply:
`curl -s -X POST localhost:8800/api/email/send -H 'Content-Type: application/json' -d '{"to":"<your-gmail>","subject":"Re: himalaya selftest","body":"reply body","in_reply_to":"<message-id>","references":"<message-id>"}'`
Expected: arrives threaded under the original in Gmail. Then mark the original answered (`POST /api/email/mark-answered/<uid>`) and confirm `is_answered:true` in `/api/email/list`.

- [ ] **Step 2: Commit (doc only, if you note results).** Skip if nothing changed.

---

## Task 11: AI-reply via the brain — `POST /api/email/ai-reply`

**Files:** Modify `backend/email_himalaya.py`

- [ ] **Step 1: Implement using the existing bridge**

`emailInbox.js`/`document.js` POST `{from_address, subject, original_body, message_id, …}` to `/api/email/ai-reply` and read `data.cached_ai_reply` (or `data.reply`). Draft via the gateway with a one-shot prompt:

```python
from . import bridge, config

async def _brain_once(prompt: str) -> str:
    """Run one non-streaming turn on a scratch web session, return the text."""
    chunks = []
    async for sse in bridge.stream_turn(prompt, session_key=config.WEB_SESSION_KEY):
        # bridge emits SSE 'data: {json}\n\n'; collect {delta} text
        line = sse[6:].strip() if sse.startswith("data:") else ""
        if not line or line == "[DONE]":
            continue
        try:
            import json as _j
            obj = _j.loads(line)
        except Exception:
            continue
        if isinstance(obj, dict) and obj.get("delta"):
            chunks.append(obj["delta"])
    return "".join(chunks).strip()

@router.post("/api/email/ai-reply")
async def ai_reply(payload: dict = Body(...)):
    subj = payload.get("subject") or ""
    frm = payload.get("from_address") or ""
    orig = (payload.get("original_body") or payload.get("body") or "")[:4000]
    prompt = ("Draft a concise, friendly reply to this email. Output only the reply body, "
              f"no preamble.\n\nFrom: {frm}\nSubject: {subj}\n\n{orig}")
    try:
        reply = await _brain_once(prompt)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"error": f"{exc!r}"})
    return {"reply": reply, "cached_ai_reply": reply}
```
NOTE: confirm the exact field the composer reads (Task spec lists `cached_ai_reply`); returning both `reply` and `cached_ai_reply` covers both call sites.

- [ ] **Step 2: Verify live.** `curl -s -X POST localhost:8800/api/email/ai-reply -H 'Content-Type: application/json' -d '{"subject":"Lunch?","from_address":"a@b.com","original_body":"Want to grab lunch Thursday?"}'`
Expected: a drafted reply string (may take 10-30s — brain turn).

- [ ] **Step 3: Commit.** `git commit -am "feat(email): AI-reply drafted by the OpenClaw brain"`

---

## Task 12: Stubs so the rich UI never errors

**Files:** Modify `backend/email_himalaya.py`

- [ ] **Step 1: Implement the stubs**

```python
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

@router.post("/api/email/{uid}/unflag-spam")
async def unflag_spam(uid: str, folder: str = "INBOX"):
    return {"ok": True}

@router.get("/api/email/contacts")
async def contacts():
    return {"contacts": []}
```
NOTE: route order — declare `/api/email/scheduled` and `/api/email/odysseus/reminders` BEFORE any `/api/email/{uid}/…` so the literal paths win.

- [ ] **Step 2: Verify the app boots and the Email tab loads without console 404 floods.** Restart; open the Email tab in the browser; check no failed `/api/email/*` calls in devtools.

- [ ] **Step 3: Commit.** `git commit -am "feat(email): stub scheduled/reminders/contacts/urgency"`

---

## Task 13: End-to-end seamless pass + memory

**Files:** none (verification) + memory update.

- [ ] **Step 1: Full manual pass in the browser** (over the tailnet): open Email → see real folders + inbox; open a message → full body; mark read/unread; archive a throwaway; compose + send to self; reply (threaded); AI-reply drafts. Note anything that looks non-Odysseus and fix.

- [ ] **Step 2: Run the unit tests.** `.venv/bin/python -m pytest backend/tests -q` → all PASS.

- [ ] **Step 3: Update memory.** Append to `project_openclaw_workspace_surfaces.md`: Email tab now real himalaya Gmail mailbox (list/folders/read/send/reply/flags/move/search/ai-reply), creds in keychain `himalaya-gmail`, config at `~/.config/himalaya/config.toml`; triage adapter removed from inbox.py.

- [ ] **Step 4: Final commit.** `git commit -am "docs: email surface done; update workspace memory pointer"`

---

## Tier 2 (follow-on, after Tier 1 is verified — separate plan or appended tasks)

Attachments download (`GET /api/email/attachment/{uid}/{idx}` → `himalaya attachment download`), `compose-upload` staging + attach-on-send, save draft (`POST /api/email/draft` → save to `[Gmail]/Drafts`), `POST /api/email/summarize` (brain), `attachment-as-doc`. Each follows the same test-pure-function + verify-live shape above. Not required for "real mailbox" v1.

---

## Self-Review

**Spec coverage:** Tier-1 endpoints from the spec all have tasks — accounts (T2), list (T3), folders (T4), read (T5), flags (T6), archive/delete/move (T7), search (T8), send (T9), reply threading (T10), ai-reply (T11), urgency/scheduled/reminders/contacts/unflag stubs (T12). Install/creds/keychain (T1). Triage stays at :3456 (no task needed). Tier-2 + stubs noted. ✅
**Placeholders:** none — every code step has concrete code; external-tool uncertainty is handled by Task-1 probe + explicit "reconcile against probe" NOTEs (honest, not a placeholder). ✅
**Type consistency:** `envelope_to_email`, `message_to_read`, `folders_from_himalaya`, `build_mime`, `himalaya_cli.run_json/run_raw/HimalayaError` names are used consistently across tasks. uid is always `str`. ✅
