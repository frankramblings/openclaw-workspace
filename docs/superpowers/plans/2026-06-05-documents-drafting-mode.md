# Documents Drafting Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cowork-style co-drafting: when a document is open beside the chat, the agent edits the vault `.md` directly and the doc pane updates in place, with a pre-turn version snapshot as undo, pandoc `.docx` export, and stale-draft nudges in the Inbox.

**Architecture:** Files-are-the-medium (spec: `docs/superpowers/specs/2026-06-05-documents-drafting-mode-design.md`). The SPA **already** posts `active_doc_id` with every turn when the doc panel is open (`frontend/js/chat.js:727-731`, auto-saving the doc first and auto-escalating to agent mode), and **already** renders a `doc_update` SSE event end-to-end (`chat.js:2120` → `documentModule.handleDocUpdate`). So the entire turn loop is backend work: snapshot → wrap message with a co-drafting note → stream → re-read the file → emit `doc_update`. Desktop side-by-side layout + drag divider already exist (`style.css:10607,10742`); chat is hidden only on mobile — **no layout work needed**.

**Tech Stack:** FastAPI (backend), vanilla ES6 modules (frontend), pytest (in `backend/tests/`, run from repo root with `.venv`), pandoc (new system dependency).

**Spec deviation (deliberate):** the spec named per-doc gateway keys `agent:main:web-doc-<docid>`. Odysseus already binds docs to chat sessions (`doc.session_id` ↔ session ↔ gateway key `agent:main:web-<id>` via `sessions_store`), and the Library's "Open" action already restores doc + session together. We reuse that — same persistence property, zero new session machinery.

**File structure:**

| File | Status | Responsibility |
|---|---|---|
| `backend/draft_mode.py` | create | pre-turn snapshot, message wrapping, post-turn `doc_update` payload |
| `backend/app.py` | modify | accept `active_doc_id`, call draft_mode hooks in `chat_stream` |
| `backend/documents.py` | modify | `GET /api/document/{id}/export?format=docx` (pandoc) |
| `backend/inbox/sources/documents_stale.py` | create | stale-draft inbox collector |
| `backend/inbox/__init__.py` | modify | register the `documents` source |
| `frontend/js/document.js` | modify | `exportAsDocx` prefers the backend endpoint, client-side fallback; `setDraftLock` |
| `frontend/js/chat.js` | modify | lock/unlock the doc editor from `updateSubmitButton` |
| `frontend/style.css` | modify | one `.draft-locked` rule |
| `backend/tests/conftest.py` | create | shared isolated-vault doc fixture |
| `backend/tests/test_draft_mode.py` | create | unit tests for draft_mode |
| `backend/tests/test_chat_stream_draft.py` | create | integration test with fake bridge |
| `backend/tests/test_documents_export.py` | create | export endpoint tests |
| `backend/tests/test_inbox_documents_stale.py` | create | collector tests |
| `README.md` | modify | pandoc dependency note |

All pytest commands run from `/Users/admin/openclaw-workspace` with `.venv/bin/pytest`.

---

### Task 1: Shared test fixture — isolated vault Documents dir

**Files:**
- Create: `backend/tests/conftest.py`

`backend/documents.py` computes `DOCS_DIR`/`VERSIONS_DIR` at import from `vs.WORKSPACE` (the real `~/.openclaw/workspace`). Tests must never touch the real vault. `_path`/`_write`/`_snapshot` read the module globals at call time, so monkeypatching them redirects everything.

- [ ] **Step 1: Write the fixture**

```python
"""Shared fixtures: an isolated vault Documents dir + a doc factory.

backend.documents computes DOCS_DIR/VERSIONS_DIR at import time from the real
vault; its helpers read the module globals at call time, so monkeypatching the
two globals redirects every read/write/snapshot into tmp_path."""
import pytest

from backend import documents


@pytest.fixture
def vault_docs(tmp_path, monkeypatch):
    docs_dir = tmp_path / "Documents"
    monkeypatch.setattr(documents, "DOCS_DIR", docs_dir)
    monkeypatch.setattr(documents, "VERSIONS_DIR", docs_dir / ".versions")

    def make(body="# Hello\n\nFirst draft.\n", **meta):
        doc = {
            "id": "abc123def456", "title": "Test Doc", "language": "markdown",
            "session_id": "sess1", "session_name": "Chat",
            "version_count": 1, "is_active": True, "archived": False,
            "created": "2026-06-01T00:00:00+00:00",
            "updated_at": "2026-06-01T00:00:00+00:00",
            "current_content": body,
        }
        doc.update(meta)
        return documents._write(doc)

    return make
```

- [ ] **Step 2: Sanity-run the existing suite (fixture alone breaks nothing)**

Run: `.venv/bin/pytest backend/tests -q`
Expected: same pass count as before this task (all green).

- [ ] **Step 3: Commit**

```bash
git add backend/tests/conftest.py
git commit -m "test: shared isolated-vault doc fixture"
```

---

### Task 2: draft_mode helpers (snapshot / wrap / doc_update payload)

**Files:**
- Create: `backend/draft_mode.py`
- Test: `backend/tests/test_draft_mode.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Unit tests for the draft-mode turn hooks (pure file work, no gateway)."""
from backend import documents, draft_mode


def test_pre_turn_snapshots_current_body(vault_docs):
    doc = vault_docs()
    out = draft_mode.pre_turn(doc["id"])
    assert out["id"] == doc["id"]
    snap = documents.VERSIONS_DIR / doc["id"] / "v1.md"
    assert snap.exists()
    assert "First draft." in snap.read_text(encoding="utf-8")


def test_pre_turn_unknown_doc_returns_none(vault_docs):
    assert draft_mode.pre_turn("nope") is None


def test_wrap_message_names_file_and_keeps_message(vault_docs):
    doc = vault_docs()
    wrapped = draft_mode.wrap_message("tighten section 2", doc)
    assert "[draft mode]" in wrapped
    assert str(documents._path(doc["id"])) in wrapped
    assert "Test Doc" in wrapped
    assert wrapped.endswith("tighten section 2")
    assert "frontmatter" in wrapped  # the do-not-touch warning


def test_post_turn_none_when_unchanged(vault_docs):
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    assert draft_mode.post_turn_payload(pre) is None


def test_post_turn_detects_agent_edit_and_bumps_version(vault_docs):
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    # Simulate the agent editing the body with its file tools.
    p = documents._path(doc["id"])
    text = p.read_text(encoding="utf-8")
    p.write_text(text.replace("First draft.", "Second draft."), encoding="utf-8")

    update = draft_mode.post_turn_payload(pre)
    assert update["type"] == "doc_update"
    assert update["doc_id"] == doc["id"]
    assert "Second draft." in update["content"]
    assert update["version"] == 2
    assert update["title"] == "Test Doc"
    # The canonical rewrite persisted the bump.
    reloaded = documents._load(doc["id"])
    assert reloaded["version_count"] == 2
    assert "Second draft." in reloaded["current_content"]


def test_post_turn_heals_stripped_frontmatter(vault_docs):
    """Agent rewrote the whole file and dropped the frontmatter block: the body
    becomes the full text, and the canonical rewrite restores good metadata."""
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    documents._path(doc["id"]).write_text("# Rewritten\n\nNo frontmatter here.\n",
                                          encoding="utf-8")
    update = draft_mode.post_turn_payload(pre)
    assert "No frontmatter here." in update["content"]
    reloaded = documents._load(doc["id"])
    assert reloaded["title"] == "Test Doc"           # metadata survived
    assert reloaded["version_count"] == 2
    raw = documents._path(doc["id"]).read_text(encoding="utf-8")
    assert raw.startswith("---")                      # frontmatter restored


def test_post_turn_none_when_file_deleted(vault_docs):
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    documents._path(doc["id"]).unlink()
    assert draft_mode.post_turn_payload(pre) is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest backend/tests/test_draft_mode.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.draft_mode'` (or ImportError).

- [ ] **Step 3: Write `backend/draft_mode.py`**

```python
"""Draft mode: the Cowork-style co-drafting turn loop.

When the SPA posts a turn with `active_doc_id` (chat.js sends it automatically
whenever the document panel is open, auto-saving the doc first), the turn is
doc-bound:

  pre_turn          — load the doc and snapshot its current body into the
                      existing version history. Direct agent edits are always
                      one restore away — this is the user's undo.
  wrap_message      — prefix the user message with a context note naming the
                      vault file and how to edit it safely.
  post_turn_payload — re-read the file after the turn; if the agent changed
                      the body, bump the version, canonically rewrite the
                      frontmatter (self-heals agent mangling), and return the
                      `doc_update` payload the SPA already renders
                      (chat.js type:"doc_update" → documentModule.handleDocUpdate).

Files are the medium: the agent edits the vault .md with its native file
tools — no bespoke edit protocol. Spec:
docs/superpowers/specs/2026-06-05-documents-drafting-mode-design.md
"""
from __future__ import annotations

from . import documents, vault_store as vs


def pre_turn(doc_id: str) -> dict | None:
    """Load + snapshot the doc before a doc-bound turn. None if it doesn't exist."""
    doc = documents._load(doc_id)
    if doc is None:
        return None
    documents._snapshot(doc)
    return doc


def wrap_message(message: str, doc: dict) -> str:
    path = documents._path(doc["id"])
    note = (
        f'[draft mode] We are co-drafting the document "{doc.get("title") or "Untitled"}" '
        f"stored at {path}. The file starts with a `---` frontmatter block — never modify "
        "or remove it; edit only the markdown body below it. When I ask for changes to "
        "the document, apply them directly to that file with your file tools, then reply "
        "with one short line on what changed — do not paste the document back into chat. "
        "If I'm just asking a question, answer normally and leave the file alone.\n\n"
    )
    return note + message


def post_turn_payload(doc: dict) -> dict | None:
    """Detect agent edits after a doc-bound turn → the `doc_update` SSE payload.

    `doc` is the dict pre_turn returned (its current_content is the pre-turn
    body — the SPA auto-saves before sending, so it's fresh). Returns None when
    the body is unchanged or the file vanished."""
    p = documents._path(doc["id"])
    if not p.exists():
        return None
    _, body = vs.parse_frontmatter(p.read_text(encoding="utf-8"))
    if body == doc.get("current_content", ""):
        return None
    doc["current_content"] = body
    doc["version_count"] = doc.get("version_count", 1) + 1
    doc["updated_at"] = vs.now_iso()
    documents._write(doc)  # canonical frontmatter rewrite
    return {"type": "doc_update", "doc_id": doc["id"], "content": body,
            "version": doc["version_count"], "title": doc.get("title", ""),
            "language": doc.get("language", "markdown")}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/pytest backend/tests/test_draft_mode.py -q`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add backend/draft_mode.py backend/tests/test_draft_mode.py
git commit -m "feat(documents): draft-mode turn hooks — snapshot, wrap, doc_update payload"
```

---

### Task 3: Wire draft mode into `/api/chat_stream`

**Files:**
- Modify: `backend/app.py` (import block ~line 20; `chat_stream` signature line 138; `gen()` body lines 160-204)
- Test: `backend/tests/test_chat_stream_draft.py`

- [ ] **Step 1: Write the failing integration test**

The fake bridge plays the agent: it edits the doc file mid-"turn". Monkeypatch `maybe_auto_extract` too — the real one fires a gateway call from `gen()`'s `finally`.

```python
"""Integration test: a doc-bound /api/chat_stream turn wraps the message and
emits doc_update before [DONE]. The bridge is faked; no gateway needed."""
import json

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, documents
from backend.app import app


def _events(sse_text: str) -> list:
    out = []
    for line in sse_text.splitlines():
        if not line.startswith("data: "):
            continue
        body = line[6:]
        try:
            out.append(json.loads(body))
        except ValueError:
            out.append(body)  # the [DONE] marker
    return out


def test_doc_bound_turn_wraps_and_emits_doc_update(vault_docs, monkeypatch):
    doc = vault_docs()
    sent = {}

    async def fake_stream_turn(message, session_key=None, model_ref=None):
        sent["message"] = message
        p = documents._path(doc["id"])
        text = p.read_text(encoding="utf-8")
        p.write_text(text.replace("First draft.", "Agent draft."), encoding="utf-8")
        yield bridge._sse({"delta": "Tightened the intro."})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    client = TestClient(app)
    res = client.post("/api/chat_stream",
                      data={"message": "tighten the intro", "session": "",
                            "active_doc_id": doc["id"]})
    assert res.status_code == 200
    events = _events(res.text)

    # The brain saw the draft-mode note + the original ask.
    assert "[draft mode]" in sent["message"]
    assert sent["message"].endswith("tighten the intro")

    updates = [e for e in events if isinstance(e, dict) and e.get("type") == "doc_update"]
    assert len(updates) == 1
    assert "Agent draft." in updates[0]["content"]
    assert updates[0]["version"] == 2
    # doc_update lands before the final [DONE].
    assert events.index(updates[0]) < len(events) - 1
    assert events[-1] == "[DONE]"
    # Undo exists: the pre-turn body was snapshotted.
    snap = documents.VERSIONS_DIR / doc["id"] / "v1.md"
    assert "First draft." in snap.read_text(encoding="utf-8")


def test_turn_without_doc_unchanged(monkeypatch):
    async def fake_stream_turn(message, session_key=None, model_ref=None):
        assert "[draft mode]" not in message
        yield bridge._sse({"delta": "hi"})

    async def fake_extract(session_key):
        return None

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)

    client = TestClient(app)
    res = client.post("/api/chat_stream", data={"message": "hello", "session": ""})
    assert res.status_code == 200
    assert "doc_update" not in res.text
    assert "[DONE]" in res.text
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/pytest backend/tests/test_chat_stream_draft.py -q`
Expected: first test FAILS — no `doc_update` in the stream (`active_doc_id` is ignored today). Second test may already pass.

- [ ] **Step 3: Wire `app.py`**

Three small edits plus the import.

Import (line 20) — add `draft_mode`:

```python
from . import bridge, config, draft_mode, sessions_store, websearch
```

Signature (line 138) — add the form field:

```python
@app.post("/api/chat_stream")
async def chat_stream(message: str = Form(...), session: str = Form(default=""),
                      use_web: str = Form(default=""),
                      active_doc_id: str = Form(default="")):
```

After `session_key = ...` (line 151), bind the doc:

```python
    # Draft mode: chat.js posts active_doc_id whenever the document panel is
    # open (auto-saving the doc first). Snapshot now (the user's undo), wrap
    # the message in gen(), detect agent edits after the turn (draft_mode.py).
    draft_doc = draft_mode.pre_turn(active_doc_id) if active_doc_id else None
```

In `gen()`, immediately before the `async for chunk in bridge.stream_turn(...)` loop (line 188):

```python
            if draft_doc is not None:
                brain_message = draft_mode.wrap_message(brain_message, draft_doc)
```

At the top of the `finally:` block (line 193), before the title settle:

```python
            if draft_doc is not None:
                try:
                    update = draft_mode.post_turn_payload(draft_doc)
                    if update:
                        yield bridge._sse(update)
                except Exception:  # noqa: BLE001 - never break the turn close
                    pass
```

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/pytest backend/tests -q`
Expected: all pass, including both new tests.

- [ ] **Step 5: Commit**

```bash
git add backend/app.py backend/tests/test_chat_stream_draft.py
git commit -m "feat(documents): doc-bound chat turns — wrap message, emit doc_update"
```

---

### Task 4: pandoc `.docx` export endpoint

**Files:**
- Modify: `backend/documents.py` (imports at top; new route after `restore_version`, ~line 241)
- Test: `backend/tests/test_documents_export.py`

- [ ] **Step 1: Install pandoc (system dependency)**

Run: `brew install pandoc`
If brew wants to **build from source** (8GB 2014 Mac mini — do not let it), abort and install the official x86_64 binary instead:

```bash
curl -L -o /tmp/pandoc.pkg https://github.com/jgm/pandoc/releases/download/3.6.3/pandoc-3.6.3-x86_64-macOS.pkg
sudo installer -pkg /tmp/pandoc.pkg -target /
```

Verify: `pandoc --version` prints a version.

- [ ] **Step 2: Write the failing tests**

```python
"""Export endpoint: pandoc-rendered .docx with honest 404/400/501 paths."""
import shutil

import pytest
from fastapi.testclient import TestClient

from backend.app import app

client = TestClient(app)


def test_export_unknown_doc_404(vault_docs):
    res = client.get("/api/document/zzzzzz/export?format=docx")
    assert res.status_code == 404


def test_export_unsupported_format_400(vault_docs):
    doc = vault_docs()
    res = client.get(f"/api/document/{doc['id']}/export?format=odt")
    assert res.status_code == 400


def test_export_without_pandoc_501(vault_docs, monkeypatch):
    doc = vault_docs()
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    res = client.get(f"/api/document/{doc['id']}/export?format=docx")
    assert res.status_code == 501
    assert "pandoc" in res.json()["error"]


@pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")
def test_export_docx_roundtrip(vault_docs):
    doc = vault_docs(body="# Title\n\n- bullet one\n- bullet two\n")
    res = client.get(f"/api/document/{doc['id']}/export?format=docx")
    assert res.status_code == 200
    assert res.content[:2] == b"PK"  # docx is a zip
    assert "Test Doc.docx" in res.headers.get("content-disposition", "")
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `.venv/bin/pytest backend/tests/test_documents_export.py -q`
Expected: all 4 FAIL with 501 "PDF export"-style or `[]` responses — the route doesn't exist, so the request falls into `app.py`'s `/api/{path:path}` catch-all returning `[]` (status 200). Assertions on status codes fail.

- [ ] **Step 4: Implement the endpoint**

Add to the imports at the top of `backend/documents.py`:

```python
import asyncio
import os
import shutil
import subprocess
import tempfile

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask
```

(keep the existing `from . import vault_store as vs`; the `APIRouter, Request` line replaces the current fastapi import line.)

Add after `restore_version` (before the PDF stub section):

```python
@router.get("/api/document/{doc_id}/export")
async def export_document(doc_id: str, format: str = "docx"):
    """Render the doc body to .docx via pandoc (real lists/tables/links).
    The SPA's client-side docx.js export remains as its fallback when this
    returns 501 (pandoc not installed)."""
    if format != "docx":
        return JSONResponse({"error": f"unsupported format '{format}'"},
                            status_code=400)
    doc = _load(doc_id)
    if doc is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    pandoc = shutil.which("pandoc")
    if not pandoc:
        return JSONResponse(
            {"error": "pandoc is not installed — brew install pandoc (or the "
                      "binary release from github.com/jgm/pandoc/releases)"},
            status_code=501)
    out = tempfile.NamedTemporaryFile(suffix=".docx", delete=False)
    out.close()
    proc = await asyncio.to_thread(
        subprocess.run,
        [pandoc, "-f", "markdown", "-t", "docx", "-o", out.name],
        input=(doc.get("current_content") or "").encode("utf-8"),
        capture_output=True, timeout=60)
    if proc.returncode != 0:
        os.unlink(out.name)
        return JSONResponse(
            {"error": f"pandoc failed: {proc.stderr.decode(errors='replace')[:300]}"},
            status_code=500)
    name = "".join(c for c in (doc.get("title") or "")
                   if c.isalnum() or c in " -_").strip()
    return FileResponse(
        out.name, filename=f"{name or 'document'}.docx",
        media_type=("application/vnd.openxmlformats-officedocument"
                    ".wordprocessingml.document"),
        background=BackgroundTask(os.unlink, out.name))
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `.venv/bin/pytest backend/tests/test_documents_export.py -q`
Expected: 4 passed (or 3 passed + 1 skipped if pandoc somehow absent).

- [ ] **Step 6: Commit**

```bash
git add backend/documents.py backend/tests/test_documents_export.py
git commit -m "feat(documents): pandoc .docx export endpoint"
```

---

### Task 5: Frontend — `exportAsDocx` prefers the backend endpoint

**Files:**
- Modify: `frontend/js/document.js:8135` (`exportAsDocx`)

No JS test harness exists in this repo; this task is verified manually in Task 8's smoke run.

- [ ] **Step 1: Add the backend-first path**

In `exportAsDocx` (line 8135), insert between the two existing guard lines and the `try { await ensureDocx(); }` block:

```javascript
  async function exportAsDocx() {
    if (!activeDocId) return;
    const textarea = document.getElementById('doc-editor-textarea');
    if (!textarea) return;
    // Prefer the backend pandoc export — real lists/tables/links. The
    // client-side docx.js path below stays as the fallback when the backend
    // says 501 (pandoc not installed) or is unreachable.
    try {
      try { await saveDocument({ silent: true }); } catch (_e) { /* best-effort */ }
      const res = await fetch(`${API_BASE}/api/document/${activeDocId}/export?format=docx`,
        { credentials: 'same-origin' });
      if (res.ok) {
        const blob = await res.blob();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = _getExportBaseName() + '.docx';
        a.click();
        URL.revokeObjectURL(a.href);
        if (uiModule) uiModule.showToast('Exported as DOCX');
        return;
      }
    } catch (_e) { /* fall through to client-side export */ }
    try {
      await ensureDocx();
    // ... (rest of the existing function unchanged)
```

- [ ] **Step 2: Syntax check**

Run: `node --check frontend/js/document.js`
Expected: exits 0. (`document.js` is an ES module — if `--check` complains about `export`, use `node --input-type=module --eval "$(cat frontend/js/document.js)"` instead, or rely on loading the page in Task 7.)

- [ ] **Step 3: Commit**

```bash
git add frontend/js/document.js
git commit -m "feat(documents): Export-as-Word prefers backend pandoc, docx.js fallback"
```

---

### Task 6: Draft lock — doc editor read-only while a doc-bound turn streams

**Files:**
- Modify: `frontend/js/document.js` (new export, near the other small exports ~line 9360)
- Modify: `frontend/js/chat.js:198,204` (inside `updateSubmitButton`)
- Modify: `frontend/style.css` (one rule, append near the doc-editor styles ~line 10770)

Spec's single-writer rule: while the agent may be editing the file, the user's textarea is disabled so a `doc_update` can never clobber in-progress typing (chat.js already auto-saves the doc *before* sending). `updateSubmitButton` is the choke point every stream start/end path funnels through (including stall recovery), so lock/unlock lives there. `handleDocUpdate` already re-enables the textarea independently — harmless overlap.

- [ ] **Step 1: Add `setDraftLock` to `frontend/js/document.js`**

Next to the other small exports (around `isPanelOpen`, line ~9368):

```javascript
  /** Draft mode: lock the editor while a doc-bound turn streams so an
   *  incoming doc_update can't clobber in-progress typing (chat.js calls
   *  this from updateSubmitButton on stream start/end). */
  export function setDraftLock(locked) {
    const ta = document.getElementById('doc-editor-textarea');
    if (ta) ta.disabled = !!locked;
    const pane = document.querySelector('.doc-editor-pane');
    if (pane) pane.classList.toggle('draft-locked', !!locked);
  }
```

- [ ] **Step 2: Call it from `updateSubmitButton` in `frontend/js/chat.js`**

In the `'streaming'` branch, after `isStreaming = true;` (line 198):

```javascript
      // Draft mode: freeze the doc editor while the agent may be editing the file
      if (documentModule && documentModule.setDraftLock && documentModule.isPanelOpen()
          && documentModule.getCurrentDocId()) {
        documentModule.setDraftLock(true);
      }
```

In the `'idle'` branch, after `isStreaming = false;` (line 204):

```javascript
      if (documentModule && documentModule.setDraftLock) documentModule.setDraftLock(false);
```

- [ ] **Step 3: Add the visual cue to `frontend/style.css`**

Append after the `.doc-editor-pane` block (~line 10775):

```css
/* Draft mode: editor frozen while a doc-bound turn streams (chat.js sets it). */
.doc-editor-pane.draft-locked #doc-editor-textarea {
  opacity: 0.6;
  cursor: wait;
}
```

- [ ] **Step 4: Syntax check**

Run: `node --check frontend/js/chat.js && node --check frontend/js/document.js`
Expected: exits 0 (same ES-module caveat as Task 5).

- [ ] **Step 5: Commit**

```bash
git add frontend/js/document.js frontend/js/chat.js frontend/style.css
git commit -m "feat(documents): freeze doc editor while a doc-bound turn streams"
```

---

### Task 7: Stale-draft inbox collector

**Files:**
- Create: `backend/inbox/sources/documents_stale.py`
- Modify: `backend/inbox/__init__.py:19,23-28` (import + `SOURCES` registration)
- Test: `backend/tests/test_inbox_documents_stale.py`

- [ ] **Step 1: Write the failing tests**

```python
"""Stale-draft collector: in-flight docs untouched for N days become inbox items."""
import asyncio
from datetime import datetime, timedelta, timezone

from backend.inbox.sources import documents_stale


def _iso_days_ago(days: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).isoformat()


def _now_ms() -> int:
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def test_map_item_stale_doc_becomes_item():
    d = {"id": "doc1", "title": "Q3 plan", "session_id": "s1",
         "session_name": "Q3 chat", "archived": False,
         "updated_at": _iso_days_ago(10), "current_content": "body text"}
    item = documents_stale.map_item(d, _now_ms())
    assert item["source"] == "documents"
    assert item["id"] == f"doc1-{item['ts']}"
    assert "10d" in item["title"] and "Q3 plan" in item["title"]
    assert item["meta"]["url"] == "/#s1"
    assert item["actions"] == ["dismiss", "snooze"]
    assert item["score"] >= 2


def test_map_item_filters():
    now = _now_ms()
    fresh = {"id": "a", "session_id": "s", "archived": False,
             "updated_at": _iso_days_ago(1), "title": "x"}
    archived = {"id": "b", "session_id": "s", "archived": True,
                "updated_at": _iso_days_ago(30), "title": "x"}
    orphan = {"id": "c", "session_id": "", "archived": False,
              "updated_at": _iso_days_ago(30), "title": "x"}
    bad_ts = {"id": "d", "session_id": "s", "archived": False,
              "updated_at": "not-a-date", "title": "x"}
    assert documents_stale.map_item(fresh, now) is None
    assert documents_stale.map_item(archived, now) is None
    assert documents_stale.map_item(orphan, now) is None
    assert documents_stale.map_item(bad_ts, now) is None


def test_fetch_scans_vault(vault_docs):
    vault_docs(id="stale1", updated_at=_iso_days_ago(7))
    vault_docs(id="fresh1", updated_at=_iso_days_ago(1))
    items = asyncio.run(documents_stale.fetch())
    assert [i["meta"]["doc_id"] for i in items] == ["stale1"]
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `.venv/bin/pytest backend/tests/test_inbox_documents_stale.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.inbox.sources.documents_stale'`.

- [ ] **Step 3: Implement the collector**

`backend/inbox/sources/documents_stale.py`:

```python
"""Stale-draft nudges: Documents that are in flight (non-archived, linked to a
chat session) but untouched for DOCS_STALE_DAYS surface in the unified inbox,
so in-flight drafts can't silently die. Item ids embed the updated_at ts: a
dismissed nudge stays dismissed while the doc is untouched, but a doc that is
edited and then goes stale AGAIN gets a fresh id and resurfaces.
Spec: docs/superpowers/specs/2026-06-05-documents-drafting-mode-design.md"""
from __future__ import annotations

import os
import time
from datetime import datetime

from ... import documents, vault_store as vs

STALE_DAYS = float(os.environ.get("DOCS_STALE_DAYS", "4"))


def _iso_ms(iso: str) -> int | None:
    try:
        return int(datetime.fromisoformat(iso).timestamp() * 1000)
    except (ValueError, TypeError):
        return None


def map_item(d: dict, now_ms: int) -> dict | None:
    """One library doc -> an inbox item, or None when it isn't a stale draft."""
    if d.get("archived") or not d.get("session_id"):
        return None
    ts = _iso_ms(d.get("updated_at") or "")
    if ts is None:
        return None
    age_h = (now_ms - ts) / 3600_000
    days = int(age_h // 24)
    if days < STALE_DAYS:
        return None
    return {
        "id": f"{d.get('id')}-{ts}", "source": "documents",
        "title": f"Draft sitting {days}d: {d.get('title') or 'Untitled'}",
        "subtitle": d.get("session_name") or "Documents",
        "snippet": (d.get("current_content") or "").strip()[:140],
        "ts": ts, "ageHours": age_h,
        # Older drafts float higher, capped so they never drown fresh inbox items.
        "score": 2 + min(days - int(STALE_DAYS), 6),
        "meta": {"doc_id": d.get("id"), "session_id": d["session_id"],
                 "url": f"/#{d['session_id']}"},
        "actions": ["dismiss", "snooze"],
    }


async def fetch() -> list[dict]:
    """Scan the vault Documents dir. Sync FS work on one folder — fine on the
    event loop (same call pattern as the obsidian collector)."""
    now_ms = int(time.time() * 1000)
    items: list[dict] = []
    if not documents.DOCS_DIR.exists():
        return items
    for p in documents.DOCS_DIR.glob("*.md"):
        try:
            d = vs.load_entry(p, content_key="current_content")
        except Exception:  # noqa: BLE001 - skip unreadable entries
            continue
        item = map_item(d, now_ms)
        if item:
            items.append(item)
    items.sort(key=lambda i: -i["score"])
    return items
```

Register in `backend/inbox/__init__.py` — change line 19 and the `SOURCES` dict:

```python
from .sources import asana, documents_stale, gmail, obsidian, slack
```

```python
SOURCES = {
    "gmail": gmail.fetch,
    "slack": slack.fetch,
    "asana": asana.fetch,
    "obsidian": obsidian.fetch,
    "documents": documents_stale.fetch,
}
```

(Generic `dismiss`/`snooze` actions in `action()` already work for any registered source — no per-source branch needed. The Inbox card's open affordance uses `meta.url`, which deep-links to the doc's session; `sessions.js:1688` reopens the session's docs automatically.)

- [ ] **Step 4: Run the full suite**

Run: `.venv/bin/pytest backend/tests -q`
Expected: all pass (existing inbox router tests confirm the new source doesn't break the merge).

- [ ] **Step 5: Commit**

```bash
git add backend/inbox/sources/documents_stale.py backend/inbox/__init__.py backend/tests/test_inbox_documents_stale.py
git commit -m "feat(inbox): stale-draft nudges from the Documents vault"
```

---

### Task 8: README + live smoke run

**Files:**
- Modify: `README.md` (dependencies/setup section)

- [ ] **Step 1: Document the pandoc dependency**

Add to README's setup/dependencies section:

```markdown
- **pandoc** (optional, for Documents → "Export as Word"): `brew install pandoc`.
  Without it the export button falls back to a lower-fidelity client-side
  converter. On the 8GB mini prefer the binary release over a source build:
  https://github.com/jgm/pandoc/releases
- `DOCS_STALE_DAYS` (default 4): days before an in-flight document surfaces
  as a nudge in the Inbox tab.
```

- [ ] **Step 2: Restart the workspace backend only** (NOT the gateway — cold-boot costs 4-5 min on this machine)

The workspace runs under launchd as `ai.openclaw.workspace` (verified live):

```bash
launchctl kickstart -k gui/$(id -u)/ai.openclaw.workspace
```

- [ ] **Step 3: Manual smoke checklist** (concurrent-session pattern: assume Signal/CLI may be mid-turn; don't touch `agent:main:main`)

1. Open the workspace, open/create a chat, create a doc in it (doc panel opens side-by-side on desktop).
2. Type "add a short section titled Background to the document" → send. Expect: tool cards stream, the agent replies one line, and the doc pane content updates in place (no reload); version badge bumps.
3. Check version history in the doc panel → the pre-turn body exists as the previous version; restore works.
4. Ask a question that needs no edit ("what's the doc's weakest section?") → answer in chat, doc untouched, no version bump.
5. Reload the browser, reopen the session from the Library → chat history present, doc reopens via `loadSessionDocs`.
6. Doc footer → Export as… → Export as Word → downloads a `.docx` that opens with real bullets/headings.
7. Backdate one doc: edit its file's `updated_at` frontmatter to >4 days ago → Inbox tab shows the "Draft sitting Nd" card; its open action lands in the doc's session; dismiss works.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: pandoc dependency + DOCS_STALE_DAYS for documents drafting mode"
```

---

## Out of scope (fast-follows, per spec)

Discuss-selection chip, per-section edit highlight, Google Drive upload, drag-resizer changes (a divider already exists). Mobile keeps current full-screen doc behavior. The spec's "last edited · vN" header chip is dropped: `#doc-version-badge` already shows the version (and `handleDocUpdate` bumps it), and the persistent chat's timestamps show recency — a second chip adds nothing.
