# Terminal Image Drop / Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drop or paste an image onto the per-chat terminal panel; it saves to the vault, types a `[name.ext]` token at the cursor, is resolvable to a real path by an in-terminal helper, and auto-rides the user's next chat turn so Gary sees the pixels.

**Architecture:** A per-session attachment registry (JSON under `config.DATA_DIR`) maps `[name.ext]` tokens → saved-file metadata. Three new FastAPI routes on the existing `terminals` router (`/attach`, `/attachments`, `/resolve`) manage it, reusing the existing `/api/upload` storage and the terminal access guard. The frontend terminal IIFE gains drop/paste handlers; the chat route merges pending registry images into the turn's vision attachments and prepends a (history-stripped) token→path note; a small `garyimg` helper resolves tokens for CLIs inside the PTY.

**Tech Stack:** Python 3.14 / FastAPI (backend), vanilla-JS IIFE (frontend), Node 22 (helper), pytest + FastAPI TestClient (tests).

## Global Constraints

- Registry files live under `config.DATA_DIR / "terminal_attachments"` (i.e. `REPO_ROOT/.data/...`, gitignored). **Not** the vault. (Supersedes the spec's `.data` path note.)
- Saved image bytes continue to live in `uploads.ATTACH_DIR` (`~/.openclaw/workspace/.attachments`), via the existing `POST /api/upload`. Do not add a second storage path.
- All new HTTP routes MUST gate on `terminals.terminal_access_allowed(client_host, headers)`, identical to the `gary-mode` routes.
- Token format: `[<basename>]`; clipboard/no-name images → `pasted-N`; collisions → `-2`, `-3`.
- `session_key` for the registry == the SPA session id (`rec["id"]` else `"global"`) — the SAME key the terminal WS, the `/attach` call, the PTY `OPENCLAW_SESSION_KEY`, and the chat-turn merge all use. Never the gateway `sessionKey`.
- Only `image/*` attachments are forwarded to the gateway (mirror `_resolve_attachments`).
- No headless Chrome on this box: frontend/helper verified via `node --check` + curl + user eyeballs; backend via pytest.
- Tests run with `OPENCLAW_TERMINAL_REQUIRE_TSHEADER=0` (TestClient host is non-loopback), matching `test_terminals_mcp.py`.

---

## File Structure

- `backend/terminals.py` — **modify.** Add registry helpers, three routes, `OPENCLAW_SESSION_KEY` env, `terminal_attachment_note()`, generalize `strip_capability_note()`, clear registry in `close_session()`.
- `backend/app.py` — **modify.** Add `_terminal_attachments()` helper; in `chat_stream.gen()` prepend the token→path note and merge pending images into the turn.
- `backend/tests/test_terminals_attach.py` — **create.** Unit tests for registry + routes + note/strip.
- `backend/tests/test_bridge_terminal_images.py` — **create.** Test the chat-route merge/consume helper.
- `scripts/garyimg` — **create.** Node resolver helper (installed into the vault bin).
- `frontend/js/workspace-terminal.js` **and** `frontend-overrides/js/workspace-terminal.js` — **modify** (byte-identical today; keep in sync). Drop/paste handlers.

---

## Task 1: Attachment registry in `terminals.py`

**Files:**
- Modify: `backend/terminals.py` (imports near top; new helpers after `close_session` at `:248-252`; edit `close_session`)
- Test: `backend/tests/test_terminals_attach.py`

**Interfaces:**
- Produces:
  - `register_attachment(session_key: str, file_id: str, name: str | None = None, mime: str | None = None) -> str` (returns the token, e.g. `"[gary.png]"`)
  - `list_attachments(session_key: str, pending_only: bool = False) -> list[dict]` (each: `{token, id, name, path, mime, ts, pending}`)
  - `resolve_attachment(session_key: str, token: str) -> str | None` (accepts token with or without brackets)
  - `mark_consumed(session_key: str, tokens: list[str]) -> None`
  - `_attachments_path(session_key: str) -> Path`

- [ ] **Step 1: Write the failing test**

Create `backend/tests/test_terminals_attach.py`:

```python
"""Per-session terminal image attachment registry: register/list/resolve/consume."""
import pytest

from backend import terminals


@pytest.fixture(autouse=True)
def _isolate_registry(tmp_path, monkeypatch):
    # Point the registry dir at a temp dir so tests never touch real .data.
    monkeypatch.setattr(terminals.config, "DATA_DIR", tmp_path, raising=False)


def test_register_returns_bracketed_token_from_name():
    tok = terminals.register_attachment("k1", "ab12cd34.png", name="gary.png", mime="image/png")
    assert tok == "[gary.png]"


def test_register_collision_suffixes():
    t1 = terminals.register_attachment("k2", "aaaa.png", name="gary.png", mime="image/png")
    t2 = terminals.register_attachment("k2", "bbbb.png", name="gary.png", mime="image/png")
    assert t1 == "[gary.png]"
    assert t2 == "[gary-2.png]"


def test_register_clipboard_no_name_uses_pasted():
    t1 = terminals.register_attachment("k3", "cccc.png", name=None, mime="image/png")
    t2 = terminals.register_attachment("k3", "dddd.png", name="", mime="image/png")
    assert t1 == "[pasted-1.png]"
    assert t2 == "[pasted-2.png]"


def test_resolve_with_and_without_brackets():
    terminals.register_attachment("k4", "eeee.png", name="x.png", mime="image/png")
    p = terminals.resolve_attachment("k4", "[x.png]")
    assert p and p.endswith("/.attachments/eeee.png")
    assert terminals.resolve_attachment("k4", "x.png") == p
    assert terminals.resolve_attachment("k4", "missing.png") is None


def test_list_and_mark_consumed():
    terminals.register_attachment("k5", "ffff.png", name="a.png", mime="image/png")
    terminals.register_attachment("k5", "gggg.png", name="b.png", mime="image/png")
    assert len(terminals.list_attachments("k5", pending_only=True)) == 2
    terminals.mark_consumed("k5", ["[a.png]"])
    pend = terminals.list_attachments("k5", pending_only=True)
    assert [it["token"] for it in pend] == ["[b.png]"]
    assert len(terminals.list_attachments("k5")) == 2  # mapping persists


def test_close_session_clears_registry():
    terminals.register_attachment("k6", "hhhh.png", name="c.png", mime="image/png")
    assert terminals._attachments_path("k6").exists()
    terminals.close_session("k6")
    assert not terminals._attachments_path("k6").exists()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py -q`
Expected: FAIL — `AttributeError: module 'backend.terminals' has no attribute 'register_attachment'`.

- [ ] **Step 3: Add imports and `config` reference**

In `backend/terminals.py`, the import block (`:6-22`) currently ends with `from . import workspace_files`. Add `json` and `Path`, and import `config`:

Change the top imports so they include:

```python
import json
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket
from starlette.websockets import WebSocketDisconnect

from . import config
from . import workspace_files
```

(Add `import json` alongside the other stdlib imports at `:8-17`; add `from pathlib import Path` after them; add `from . import config` next to `from . import workspace_files` at `:22`.)

- [ ] **Step 4: Implement the registry helpers**

In `backend/terminals.py`, insert immediately after `close_session` (currently `:248-252`):

```python
# --- Terminal image attachments: per-session token → file registry ----------
# Images dropped/pasted into a chat's terminal are uploaded via /api/upload
# (bytes land in uploads.ATTACH_DIR, inside Gary's vault) and registered here.
# A "[name.ext]" token is typed into the PTY; the registry maps it to the saved
# path. `pending` is True until a chat turn consumes the image as a vision
# attachment; the token→path mapping itself persists for the session lifetime so
# an in-terminal CLI can resolve it any time.
def _attachments_dir() -> Path:
    return config.DATA_DIR / "terminal_attachments"


def _sanitize_key(session_key: str) -> str:
    safe = "".join(c for c in (session_key or "") if c.isalnum() or c in "-_")
    return safe or "global"


def _attachments_path(session_key: str) -> Path:
    return _attachments_dir() / (_sanitize_key(session_key) + ".json")


def _load_attachments(session_key: str) -> dict:
    try:
        return json.loads(_attachments_path(session_key).read_text())
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_attachments(session_key: str, data: dict) -> None:
    p = _attachments_path(session_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(p)


def _unique_token(reg: dict, base: str, ext: str) -> str:
    cand = f"[{base}{ext}]"
    if cand not in reg:
        return cand
    n = 2
    while f"[{base}-{n}{ext}]" in reg:
        n += 1
    return f"[{base}-{n}{ext}]"


def register_attachment(session_key: str, file_id: str,
                        name: str | None = None, mime: str | None = None) -> str:
    """Register an uploaded image for a chat's terminal; return its [token]."""
    from .uploads import ATTACH_DIR
    reg = _load_attachments(session_key)
    ext = Path(file_id).suffix or (Path(name).suffix if name else "") or ""
    stem = Path(name).stem if name else ""
    if stem:
        base = stem
    else:
        n = sum(1 for t in reg if t.startswith("[pasted-")) + 1
        base = f"pasted-{n}"
    token = _unique_token(reg, base, ext)
    reg[token] = {
        "id": file_id,
        "name": name or (base + ext),
        "path": str(ATTACH_DIR / file_id),
        "mime": mime or "",
        "ts": int(time.time()),
        "pending": True,
    }
    _save_attachments(session_key, reg)
    return token


def list_attachments(session_key: str, pending_only: bool = False) -> list[dict]:
    reg = _load_attachments(session_key)
    out = []
    for token, e in reg.items():
        if pending_only and not e.get("pending"):
            continue
        out.append({"token": token, **e})
    return out


def resolve_attachment(session_key: str, token: str) -> str | None:
    reg = _load_attachments(session_key)
    e = reg.get(token)
    if e is None and token and not token.startswith("["):
        e = reg.get(f"[{token}]")
    return e.get("path") if e else None


def mark_consumed(session_key: str, tokens: list[str]) -> None:
    reg = _load_attachments(session_key)
    changed = False
    for t in tokens:
        if t in reg and reg[t].get("pending"):
            reg[t]["pending"] = False
            changed = True
    if changed:
        _save_attachments(session_key, reg)
```

Then edit `close_session` (currently `:248-252`) to clear the registry file:

```python
def close_session(session_key: str) -> None:
    sess = _sessions.pop(session_key, None)
    if sess:
        sess.close()
    try:
        _attachments_path(session_key).unlink()
    except (FileNotFoundError, OSError):
        pass
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py -q`
Expected: PASS (6 passed).

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminals_attach.py
git commit -m "feat(terminals): per-session image attachment registry"
```

---

## Task 2: Attachment HTTP routes

**Files:**
- Modify: `backend/terminals.py` (add three routes after `terminal_close` at `:426-432`)
- Test: `backend/tests/test_terminals_attach.py` (append route tests)

**Interfaces:**
- Consumes: `register_attachment`, `list_attachments`, `resolve_attachment` (Task 1); `terminal_access_allowed`.
- Produces routes:
  - `POST /api/terminal/{session_key}/attach` body `{file_id, name?, mime?}` → `{token}`
  - `GET  /api/terminal/{session_key}/attachments?pending=0|1` → `{attachments: [...]}`
  - `GET  /api/terminal/{session_key}/resolve?token=...` → `{path}` (404 if unknown)

- [ ] **Step 1: Write the failing test**

Append to `backend/tests/test_terminals_attach.py`:

```python
from fastapi.testclient import TestClient

from backend.app import app


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")
    return TestClient(app)


def test_attach_route_returns_token(client):
    r = client.post("/api/terminal/routekey/attach",
                    json={"file_id": "zz11.png", "name": "shot.png", "mime": "image/png"})
    assert r.status_code == 200
    assert r.json()["token"] == "[shot.png]"


def test_attach_requires_file_id(client):
    r = client.post("/api/terminal/routekey/attach", json={"name": "x.png"})
    assert r.status_code == 400


def test_attachments_list_pending_filter(client):
    client.post("/api/terminal/listkey/attach", json={"file_id": "a1.png", "name": "a.png"})
    terminals.mark_consumed("listkey", ["[a.png]"])
    client.post("/api/terminal/listkey/attach", json={"file_id": "b1.png", "name": "b.png"})
    all_ = client.get("/api/terminal/listkey/attachments").json()["attachments"]
    pend = client.get("/api/terminal/listkey/attachments?pending=1").json()["attachments"]
    assert len(all_) == 2
    assert [it["token"] for it in pend] == ["[b.png]"]


def test_resolve_route(client):
    client.post("/api/terminal/reskey/attach", json={"file_id": "c1.png", "name": "c.png"})
    ok = client.get("/api/terminal/reskey/resolve", params={"token": "[c.png]"})
    assert ok.status_code == 200 and ok.json()["path"].endswith("/.attachments/c1.png")
    miss = client.get("/api/terminal/reskey/resolve", params={"token": "[nope.png]"})
    assert miss.status_code == 404
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py -q -k route or resolve`
Expected: FAIL — 404 from the router (routes not yet defined).

- [ ] **Step 3: Implement the routes**

In `backend/terminals.py`, insert after `terminal_close` (currently ends `:432`):

```python
@router.post("/api/terminal/{session_key}/attach")
async def terminal_attach(session_key: str, request: Request):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    body = await request.json()
    file_id = str(body.get("file_id", ""))
    if not file_id:
        raise HTTPException(status_code=400, detail="file_id required")
    token = register_attachment(session_key, file_id,
                                name=body.get("name"), mime=body.get("mime"))
    return {"token": token}


@router.get("/api/terminal/{session_key}/attachments")
async def terminal_attachments(session_key: str, request: Request, pending: int = 0):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    return {"attachments": list_attachments(session_key, pending_only=bool(pending))}


@router.get("/api/terminal/{session_key}/resolve")
async def terminal_resolve(session_key: str, request: Request, token: str = ""):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    path = resolve_attachment(session_key, token)
    if not path:
        raise HTTPException(status_code=404, detail="unknown token")
    return {"path": path}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py -q`
Expected: PASS (all, ~10 passed).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminals_attach.py
git commit -m "feat(terminals): attach/list/resolve routes for terminal images"
```

---

## Task 3: PTY env, Gary turn-context note, and chat-turn merge

**Files:**
- Modify: `backend/terminals.py` (`PtySession.start` `:80-82`; add `terminal_attachment_note`; generalize `strip_capability_note` `:325-333`)
- Modify: `backend/app.py` (add `_terminal_attachments` near `_resolve_attachments` `:319-354`; edit `chat_stream.gen()` around `:431-439`)
- Test: `backend/tests/test_bridge_terminal_images.py`; extend `test_terminals_attach.py` for the note/strip.

**Interfaces:**
- Consumes: `list_attachments`, `mark_consumed` (Task 1).
- Produces:
  - `terminals.terminal_attachment_note(session_key: str) -> str` (`""` if no entries; else a marker block ending `\n\n`)
  - `app._terminal_attachments(terminal_key: str) -> list[dict]` (image blocks `{type,mimeType,fileName,content}`; marks them consumed)
  - PTY env gains `OPENCLAW_SESSION_KEY`.

- [ ] **Step 1: Write the failing tests (note + strip)**

Append to `backend/tests/test_terminals_attach.py`:

```python
def test_attachment_note_lists_tokens_and_strips():
    terminals.register_attachment("notek", "ii.png", name="gary.png", mime="image/png")
    note = terminals.terminal_attachment_note("notek")
    assert note.startswith(terminals._ATTACH_NOTE_PREFIX)
    assert "[gary.png]" in note and note.endswith("\n\n")
    msg = note + "hello user"
    assert terminals.strip_capability_note(msg) == "hello user"


def test_attachment_note_empty_when_none():
    assert terminals.terminal_attachment_note("emptyk") == ""


def test_strip_handles_both_leading_blocks(monkeypatch):
    monkeypatch.setattr(terminals, "gary_mode_for_session", lambda k: True)
    cap = terminals.gary_capability_note("bothk")
    terminals.register_attachment("bothk", "jj.png", name="z.png", mime="image/png")
    att = terminals.terminal_attachment_note("bothk")
    assert terminals.strip_capability_note(cap + att + "BODY") == "BODY"
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py -q -k note or strip`
Expected: FAIL — `AttributeError: ... has no attribute 'terminal_attachment_note'`.

- [ ] **Step 3: Add the PTY env var**

In `backend/terminals.py` `PtySession.start`, after `:82` (`env["OPENCLAW_ATTACHED_TERMINAL"] = "1"`) add:

```python
        env["OPENCLAW_SESSION_KEY"] = self.session_key
```

- [ ] **Step 4: Add the note function and generalize strip**

In `backend/terminals.py`, add a new marker constant next to `_GARY_NOTE_PREFIX` (`:300`):

```python
_ATTACH_NOTE_PREFIX = "⁣[terminal-images]"
```

Add the note builder (place it right after `gary_capability_note`, before `strip_capability_note` at `:325`):

```python
def terminal_attachment_note(session_key: str) -> str:
    """A per-turn, history-stripped note mapping the chat's terminal image
    tokens to their on-disk paths, so Gary can resolve a [name.ext] he sees in
    chat text or terminal output. Empty when the chat has no terminal images."""
    items = list_attachments(session_key)
    if not items:
        return ""
    lines = "\n".join(f"  {it['token']} → {it['path']}" for it in items)
    return (
        f"{_ATTACH_NOTE_PREFIX} Images the user dropped into THIS chat's terminal "
        "are saved as files. A [name.ext] token in the terminal or chat refers to:\n"
        f"{lines}\n\n"
    )
```

Replace `strip_capability_note` (`:325-333`) with a version that strips ALL leading marker blocks:

```python
def strip_capability_note(text: str) -> str:
    """Remove injected per-turn context blocks (terminal-control and/or
    terminal-images) from a stored message for display. Anchored at the start —
    the notes are always *prepended* — and looped so multiple stacked blocks are
    all removed. Each block runs from its marker to the first blank line."""
    if not isinstance(text, str):
        return text
    while text.startswith(_GARY_NOTE_PREFIX) or text.startswith(_ATTACH_NOTE_PREFIX):
        end = text.find("\n\n")
        text = text[end + 2:] if end != -1 else ""
    return text
```

- [ ] **Step 5: Run the note/strip tests**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py -q`
Expected: PASS.

- [ ] **Step 6: Write the failing test for the chat-route merge helper**

Create `backend/tests/test_bridge_terminal_images.py`:

```python
"""chat_stream merges pending terminal images into the turn's vision attachments
and marks them consumed (one-turn delivery)."""
import base64

import pytest

from backend import app as appmod
from backend import terminals


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(terminals.config, "DATA_DIR", tmp_path / "data", raising=False)
    # Real .attachments dir with a tiny PNG so read_bytes/mime succeed.
    from backend.uploads import ATTACH_DIR
    ATTACH_DIR.mkdir(parents=True, exist_ok=True)
    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")
    (ATTACH_DIR / "merge1.png").write_bytes(png)


def test_pending_terminal_image_becomes_attachment_block_and_consumed():
    terminals.register_attachment("mk", "merge1.png", name="m.png", mime="image/png")
    blocks = appmod._terminal_attachments("mk")
    assert len(blocks) == 1
    b = blocks[0]
    assert b["type"] == "image" and b["mimeType"] == "image/png" and b["fileName"] == "merge1.png"
    assert base64.b64decode(b["content"])  # valid base64
    # Consumed → no longer pending, but still resolvable.
    assert appmod._terminal_attachments("mk") == []
    assert terminals.resolve_attachment("mk", "[m.png]")


def test_missing_file_is_skipped_not_fatal():
    terminals.register_attachment("mk2", "gone.png", name="g.png", mime="image/png")
    assert appmod._terminal_attachments("mk2") == []
```

- [ ] **Step 7: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_bridge_terminal_images.py -q`
Expected: FAIL — `AttributeError: module 'backend.app' has no attribute '_terminal_attachments'`.

- [ ] **Step 8: Implement `_terminal_attachments` in app.py**

First ensure `from pathlib import Path` is imported in `backend/app.py` (check the import block near `:13`; if absent, add it). Then insert after `_resolve_attachments` (ends `:354`):

```python
def _terminal_attachments(terminal_key: str) -> list[dict]:
    """Pending images the user dropped into this chat's terminal → chat.send
    image blocks, then mark them consumed so each rides exactly one turn. The
    token→path mapping itself persists (terminals registry) for later resolves.
    Mirrors _resolve_attachments' block shape; image/* only; bad files skipped."""
    out: list[dict] = []
    consumed: list[str] = []
    for it in terminals.list_attachments(terminal_key, pending_only=True):
        path = Path(it.get("path", ""))
        if not path.is_file():
            continue
        mime = it.get("mime") or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        if not mime.startswith("image/"):
            continue
        try:
            data = path.read_bytes()
        except Exception:  # noqa: BLE001 - unreadable → skip, never break the turn
            continue
        out.append({
            "type": "image",
            "mimeType": mime,
            "fileName": path.name,
            "content": base64.b64encode(data).decode("ascii"),
        })
        consumed.append(it["token"])
    if consumed:
        terminals.mark_consumed(terminal_key, consumed)
    return out
```

- [ ] **Step 9: Run the merge test to verify it passes**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_bridge_terminal_images.py -q`
Expected: PASS (2 passed).

- [ ] **Step 10: Wire the merge + note into `chat_stream.gen()`**

In `backend/app.py`, the `gen()` block currently reads (around `:431-439`):

```python
            terminal_key = rec["id"] if rec else "global"
            if terminals.gary_mode_for_session(terminal_key):
                brain_message = terminals.gary_capability_note(terminal_key) + brain_message
            _ACTIVE_RUNS[session_key] = run_info
            async for chunk in bridge.stream_turn(brain_message, session_key=session_key,
                                                  model_ref=_model_ref(rec),
                                                  attachments=chat_attachments,
                                                  run_info=run_info,
                                                  thinking=_thinking_for_speed((rec or {}).get("speed"))):
```

Replace it with (adds the note prepend, the per-turn merged attachment list, keeps gary note prepended last so it stays the first block):

```python
            terminal_key = rec["id"] if rec else "global"
            # Terminal image drops: prepend the (history-stripped) token→path map
            # and merge any pending dropped images into THIS turn's vision blocks.
            att_note = terminals.terminal_attachment_note(terminal_key)
            if att_note:
                brain_message = att_note + brain_message
            turn_attachments = chat_attachments + _terminal_attachments(terminal_key)
            if terminals.gary_mode_for_session(terminal_key):
                brain_message = terminals.gary_capability_note(terminal_key) + brain_message
            _ACTIVE_RUNS[session_key] = run_info
            async for chunk in bridge.stream_turn(brain_message, session_key=session_key,
                                                  model_ref=_model_ref(rec),
                                                  attachments=turn_attachments,
                                                  run_info=run_info,
                                                  thinking=_thinking_for_speed((rec or {}).get("speed"))):
```

- [ ] **Step 11: Run the full backend suite for regressions**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_terminals_attach.py backend/tests/test_bridge_terminal_images.py backend/tests/test_terminals.py backend/tests/test_terminals_mcp.py -q`
Expected: PASS (no regressions; history-strip behavior unchanged for existing cases).

- [ ] **Step 12: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/app.py backend/tests/test_terminals_attach.py backend/tests/test_bridge_terminal_images.py
git commit -m "feat(terminals): merge dropped terminal images into chat turn + token map"
```

---

## Task 4: `garyimg` resolver helper

**Files:**
- Create: `scripts/garyimg`
- Test: `backend/tests/test_garyimg_helper.py` (no-network guard paths)

**Interfaces:**
- Consumes: `GET /api/terminal/{key}/resolve` (Task 2); env `OPENCLAW_SESSION_KEY` (Task 3).
- Produces: `scripts/garyimg <name.ext|[name.ext]>` → prints absolute path (exit 0) / errors to stderr (exit 1 not-found, exit 2 usage/env).

- [ ] **Step 1: Write the failing test (guard paths, no network)**

Create `backend/tests/test_garyimg_helper.py`:

```python
"""garyimg helper: deterministic no-network guard paths (usage / missing env)."""
import subprocess
from pathlib import Path

HELPER = Path(__file__).resolve().parents[2] / "scripts" / "garyimg"


def _run(args, env):
    return subprocess.run(["node", str(HELPER), *args], env=env,
                          capture_output=True, text=True)


def test_missing_env_exits_2():
    r = _run(["gary.png"], env={"PATH": "/usr/bin:/bin"})
    assert r.returncode == 2
    assert "OPENCLAW_SESSION_KEY" in r.stderr


def test_missing_arg_exits_2():
    r = _run([], env={"PATH": "/usr/bin:/bin", "OPENCLAW_SESSION_KEY": "k"})
    assert r.returncode == 2
    assert "usage" in r.stderr.lower()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /Users/admin/openclaw-workspace && .venv/bin/python -m pytest backend/tests/test_garyimg_helper.py -q`
Expected: FAIL — node cannot find `scripts/garyimg` (file does not exist).

- [ ] **Step 3: Write the helper**

Create `scripts/garyimg`:

```javascript
#!/usr/bin/env node
// Resolve a [name.ext] terminal-image token to its real path, for CLIs running
// inside a chat's attached terminal. Reads OPENCLAW_SESSION_KEY (set on the PTY)
// and asks the workspace backend. Usage: claude "look at $(garyimg gary.png)"
const key = process.env.OPENCLAW_SESSION_KEY;
const arg = process.argv[2];
if (!key) {
  process.stderr.write('garyimg: OPENCLAW_SESSION_KEY not set (run inside the chat terminal)\n');
  process.exit(2);
}
if (!arg) {
  process.stderr.write('usage: garyimg <name.ext|[name.ext]>\n');
  process.exit(2);
}
const token = arg.startsWith('[') ? arg : `[${arg}]`;
const base = process.env.OPENCLAW_TERMINAL_BASE || 'http://127.0.0.1:8800';
const url = `${base}/api/terminal/${encodeURIComponent(key)}/resolve`
  + `?token=${encodeURIComponent(token)}`;
fetch(url).then(async (r) => {
  if (!r.ok) { process.stderr.write(`garyimg: ${token} not found\n`); process.exit(1); }
  const d = await r.json();
  if (!d.path) { process.stderr.write(`garyimg: ${token} not found\n`); process.exit(1); }
  process.stdout.write(d.path + '\n');
}).catch((e) => { process.stderr.write('garyimg: ' + e.message + '\n'); process.exit(1); });
```

Make it executable:

```bash
chmod +x /Users/admin/openclaw-workspace/scripts/garyimg
```

- [ ] **Step 4: Syntax-check and run the guard tests**

Run: `cd /Users/admin/openclaw-workspace && node --check scripts/garyimg && .venv/bin/python -m pytest backend/tests/test_garyimg_helper.py -q`
Expected: `node --check` silent (exit 0); pytest PASS (2 passed).

- [ ] **Step 5: Install into the vault bin (PTY cwd)**

The terminal's cwd is `~/.openclaw/workspace`; put the helper on that bin so `./bin/garyimg name` works (and `garyimg name` if `bin` is on PATH):

```bash
ln -sf /Users/admin/openclaw-workspace/scripts/garyimg /Users/admin/.openclaw/workspace/bin/garyimg
ls -l /Users/admin/.openclaw/workspace/bin/garyimg
```

Expected: symlink listed, pointing at `scripts/garyimg`.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add scripts/garyimg backend/tests/test_garyimg_helper.py
git commit -m "feat: garyimg helper to resolve terminal image tokens to paths"
```

---

## Task 5: Frontend drop / paste handlers

**Files:**
- Modify: `frontend/js/workspace-terminal.js` **and** `frontend-overrides/js/workspace-terminal.js` (identical edits — they are byte-identical today; keep in sync)

**Interfaces:**
- Consumes: `POST /api/upload` → `{files:[{id,name,url}]}`; `POST /api/terminal/{key}/attach` → `{token}`; existing IIFE internals `ws`, `sessionKey`, `send()`, `status()`.

- [ ] **Step 1: Confirm both files are identical (sync precondition)**

Run: `cd /Users/admin/openclaw-workspace && diff frontend/js/workspace-terminal.js frontend-overrides/js/workspace-terminal.js && echo IDENTICAL`
Expected: `IDENTICAL` (apply the same edit to both in the following steps).

- [ ] **Step 2: Add the upload/attach/handlers block**

In `frontend/js/workspace-terminal.js`, insert this block immediately before `function wireResize(aside) {` (currently `:225`):

```javascript
  // --- image drop / paste --------------------------------------------------
  // Drop or paste an image onto the terminal: upload it (same store as chat
  // attachments, inside Gary's vault), register a [name.ext] token, and type
  // the token at the cursor. The image auto-rides the user's next chat turn so
  // Gary sees it; an in-terminal CLI can resolve the token with `garyimg`.
  function isImageFile(f) {
    return (f.type && f.type.indexOf('image/') === 0)
      || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(f.name || '');
  }
  function imagesFrom(fileList) {
    return Array.prototype.slice.call(fileList || []).filter(isImageFile);
  }
  function uploadImage(file) {
    const fd = new FormData();
    fd.append('files', file, file.name || 'pasted-image.png');
    return fetch('/api/upload', { method: 'POST', body: fd })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('upload http ' + r.status))))
      .then((d) => (d.files && d.files[0]) || Promise.reject(new Error('no file')));
  }
  function attachToken(file, up) {
    return fetch('/api/terminal/' + encodeURIComponent(sessionKey) + '/attach', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: up.id, name: up.name || file.name || '', mime: file.type || '' }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('attach http ' + r.status))))
      .then((d) => d.token);
  }
  async function processImages(imgs) {
    if (!ws || ws.readyState !== 1 || !sessionKey) { status('terminal not connected'); return; }
    for (const f of imgs) {
      status('uploading image…');
      try {
        const up = await uploadImage(f);
        const token = await attachToken(f, up);
        send({ type: 'input', data: token + ' ' });
        status('');
      } catch (e) { status('image upload failed'); }
    }
  }
  function wireImageDrop(el) {
    if (!el || el.__wtImageWired) return;
    el.__wtImageWired = true;
    el.addEventListener('dragover', (e) => {
      const dt = e.dataTransfer;
      if (dt && Array.prototype.some.call(dt.items || [], (i) => i.kind === 'file')) e.preventDefault();
    });
    el.addEventListener('drop', (e) => {
      const imgs = imagesFrom(e.dataTransfer && e.dataTransfer.files);
      if (imgs.length) { e.preventDefault(); processImages(imgs); }
    });
    el.addEventListener('paste', (e) => {
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) { if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); } }
      const imgs = files.filter(isImageFile);
      if (imgs.length) { e.preventDefault(); processImages(imgs); }
    });
  }

```

- [ ] **Step 3: Call `wireImageDrop` once after the terminal is built**

In `open()`, inside the `if (!term) { ... }` block, after `term.onData((d) => send({ type: 'input', data: d }));` (currently `:170`), add:

```javascript
      wireImageDrop(document.getElementById('wt-screen'));
```

- [ ] **Step 4: Apply the identical edits to the override copy**

Repeat Step 2 and Step 3 in `frontend-overrides/js/workspace-terminal.js` at the same locations.

- [ ] **Step 5: Syntax-check both files**

Run: `cd /Users/admin/openclaw-workspace && node --check frontend/js/workspace-terminal.js && node --check frontend-overrides/js/workspace-terminal.js && diff frontend/js/workspace-terminal.js frontend-overrides/js/workspace-terminal.js && echo OK_IDENTICAL`
Expected: `OK_IDENTICAL` (both parse; still identical).

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend/js/workspace-terminal.js frontend-overrides/js/workspace-terminal.js
git commit -m "feat(terminal-ui): drop/paste images into the attached terminal"
```

---

## Task 6: End-to-end manual verification

**Files:** none (verification only).

- [ ] **Step 1: Restart the backend and open the app**

Restart uvicorn (however it's managed on this box), then open the workspace on the `https://bespin…:8443` origin and open the Terminal panel on a saved chat.

- [ ] **Step 2: Drop test**

Drag an image file (e.g. `gary.png`) onto the terminal screen.
Expected: `[gary.png]` appears at the cursor; brief "uploading image…" then clears.

- [ ] **Step 3: Paste test**

Copy an image to the clipboard, focus the terminal, paste (Cmd-V).
Expected: a `[pasted-1.png]` token appears at the cursor.

- [ ] **Step 4: Helper resolve test**

In the terminal: `./bin/garyimg gary.png` (or `garyimg gary.png` if `bin` is on PATH).
Expected: prints an absolute path under `.../.attachments/`. Confirm `cat "$(./bin/garyimg gary.png)" | head -c 8 | xxd` shows PNG/JPEG magic bytes.

- [ ] **Step 5: Gary awareness test**

After dropping an image, send a chat message like "what's in the image I just dropped in the terminal?"
Expected: Gary describes the dropped image (it rode the turn as a vision attachment), and can refer to it by `[gary.png]`.

- [ ] **Step 6: Pass-through test**

Paste plain text into the terminal.
Expected: text is typed into the shell normally (no upload attempted).

---

## Self-Review notes (already reconciled)

- **Spec coverage:** registry (Task 1), 3 endpoints (Task 2), PTY env + Gary awareness + auto-attach (Task 3), `garyimg` resolver (Task 4), frontend drop/paste (Task 5), tests across all + manual E2E (Task 6).
- **Path deviation from spec:** registry uses `config.DATA_DIR/terminal_attachments` (the app's gitignored data dir), not the vault `.data` — recorded in Global Constraints.
- **Type/name consistency:** `register_attachment / list_attachments / resolve_attachment / mark_consumed / terminal_attachment_note / _attachments_path` used identically across Tasks 1–3 and tests; `_terminal_attachments` (app.py) consumes `list_attachments(pending_only=True)` + `mark_consumed`.
- **Helper install:** source of truth `scripts/garyimg` (version-controlled), symlinked into the vault bin (PTY cwd) in Task 4 Step 5.
