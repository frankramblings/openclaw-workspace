"""GET /api/export — a real, read-only backup zip of the workspace's own data.

Bundles the four categories of data this app itself persists (as opposed to
chat message CONTENT, which lives in the OpenClaw brain/codex and is read
back on demand — see sessions_store.py's module docstring, which stores only
session METADATA):
  - sessions.json        session id <-> gateway sessionKey, name, model, flags
  - Notes/*.md            the Notes tab's vault files (notes.py)
  - Documents/*.md         the Documents tab's vault files, incl. .versions/
                           (documents.py)
  - memory/MEMORY.md       curated long-term memory + the pin overlay/prefs
                           sidecars (memory.py)

Every path below is read via each domain module's own module-level constant
(sessions_store._STORE_FILE, notes.NOTES_DIR, documents.DOCS_DIR,
memory.MEMORY_MD/_OVERLAY/_PREFS) rather than recomputed here, so this stays
in sync with wherever those modules actually read/write and so tests that
already monkeypatch those constants (e.g. the `vault_docs` fixture) transparently
isolate this route too.

Read-only: nothing here ever creates, deletes, or modifies a file. Replaces
the byte-identical `[]` legacy stub (see app.py's "Legacy GET stubs" block)
that the redesign Settings -> Data Backup -> Export button used to silently
download as a fake, empty "backup.json".
"""
from __future__ import annotations

import asyncio
import io
import logging
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import StreamingResponse

from . import documents, memory, notes, sessions_store

log = logging.getLogger(__name__)

router = APIRouter()


def _add_file(zf: zipfile.ZipFile, arcname: str, path: Path) -> None:
    """Add one file to the zip if it exists. Best-effort: a single unreadable
    file (permissions, a race with a concurrent writer) must not sink the
    whole export — it's just skipped and logged."""
    try:
        if path.is_file():
            zf.write(path, arcname)
    except OSError as exc:
        log.warning("export: skipping %s (%s)", path, exc)


def _add_dir(zf: zipfile.ZipFile, arcprefix: str, dir_path: Path) -> None:
    """Add every file under `dir_path` (recursively — this also picks up
    documents.py's Documents/.versions/ snapshots) under `arcprefix/`."""
    if not dir_path.is_dir():
        return
    for p in sorted(dir_path.rglob("*")):
        if p.is_file():
            try:
                zf.write(p, f"{arcprefix}/{p.relative_to(dir_path)}")
            except OSError as exc:
                log.warning("export: skipping %s (%s)", p, exc)


def _build_zip() -> bytes:
    """Synchronous — every call here is local disk I/O; run via
    asyncio.to_thread so the event loop isn't blocked (same rationale as
    notes._load_all / documents._scan_docs)."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        _add_file(zf, "sessions.json", sessions_store._STORE_FILE)
        _add_dir(zf, "notes", notes.NOTES_DIR)
        _add_dir(zf, "documents", documents.DOCS_DIR)
        _add_file(zf, "memory/MEMORY.md", memory.MEMORY_MD)
        _add_file(zf, "memory/memory_overlay.json", memory._OVERLAY)
        _add_file(zf, "memory/memory_prefs.json", memory._PREFS)
    return buf.getvalue()


@router.get("/api/export")
async def export_backup():
    """Real backup: a zip of sessions/notes/documents/memory. Registered
    explicitly (not routed through the generic /api/{path} catch-all in
    app.py) so it always wins."""
    data = await asyncio.to_thread(_build_zip)
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    filename = f"openclaw-backup-{ts}.zip"
    return StreamingResponse(
        iter([data]),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
