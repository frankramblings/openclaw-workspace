"""Notes tab → markdown files in the agent vault (`~/.openclaw/workspace/Notes`).

Backs the Odysseus Notes UI (Google-Keep-style cards). Each note is one `.md`
file: structured fields (title, pinned, color, archived, tags, sort, checklist
`items`, reminder `due`/`repeat`, …) live in frontmatter; the note body is the
markdown content. The full note JSON the frontend POSTs is round-tripped, so
rich fields survive even though v1's "editor" is the SPA's existing textarea.

Frontend contract (js/notes.js):
  GET    /api/notes[?archived=true]   -> {"notes": [...]}
  POST   /api/notes                   (note JSON)  -> note
  PUT    /api/notes/{id}              (note|patch) -> note
  DELETE /api/notes/{id}
  POST   /api/notes/reorder           {"ids": [...]}
  POST   /api/notes/fire-reminder     (stub)
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import vault_store as vs

log = logging.getLogger(__name__)

router = APIRouter()

NOTES_DIR = vs.WORKSPACE / "Notes"


def _path(note_id: str):
    # Guard against path traversal via the id.
    safe = "".join(c for c in str(note_id) if c.isalnum() or c in "-_")
    return NOTES_DIR / f"{safe}.md"


def _load_all() -> list[dict]:
    if not NOTES_DIR.exists():
        return []
    notes = []
    for p in NOTES_DIR.glob("*.md"):
        try:
            notes.append(vs.load_entry(p))
        except Exception:
            continue
    return notes


def _sort_key(n: dict):
    # Pinned first, then by explicit sort index, then most-recently updated.
    return (
        0 if n.get("pinned") else 1,
        n.get("sort", 1e9),
        _neg_iso(n.get("updated", "")),
    )


def _neg_iso(s: str) -> str:
    # Descending string sort trick for ISO timestamps.
    return "".join(chr(255 - ord(c)) for c in s)


@router.get("/api/notes")
async def list_notes(archived: str | None = None):
    want_archived = str(archived).lower() == "true"
    # Disk scan off the event loop — same rationale as documents._scan_docs.
    all_notes = await asyncio.to_thread(_load_all)
    notes = [n for n in all_notes if bool(n.get("archived")) == want_archived]
    notes.sort(key=_sort_key)
    return {"notes": notes}


@router.post("/api/notes")
async def create_note(request: Request):
    note = await request.json()
    note["id"] = note.get("id") or vs.new_id()
    note.setdefault("created", vs.now_iso())
    note["updated"] = vs.now_iso()
    return _write(note)


@router.put("/api/notes/{note_id}")
async def update_note(note_id: str, request: Request):
    patch = await request.json()
    path = _path(note_id)
    note = vs.load_entry(path) if path.exists() else {"id": note_id, "created": vs.now_iso()}
    note.update(patch)
    note["id"] = note_id
    note["updated"] = vs.now_iso()
    return _write(note)


@router.delete("/api/notes/{note_id}")
async def delete_note(note_id: str):
    path = _path(note_id)
    if path.exists():
        path.unlink()
    return {"ok": True}


@router.post("/api/notes/reorder")
async def reorder_notes(request: Request):
    body = await request.json()
    for idx, nid in enumerate(body.get("ids", [])):
        path = _path(nid)
        if not path.exists():
            continue
        note = vs.load_entry(path)
        note["sort"] = idx
        content = note.pop("content", "")
        try:
            vs.save_entry(path, note, content)
        except Exception:  # noqa: BLE001 - fsutil now raises on write failure
            # (Task 10); an unguarded reorder used to look like it succeeded
            # (200 {"ok": true}) even when the sort order silently didn't
            # persist. Surface it honestly instead.
            log.error("vault write failed reordering note %s", nid, exc_info=True)
            return JSONResponse({"error": "write failed"}, status_code=500)
    return {"ok": True}


@router.post("/api/notes/fire-reminder")
async def fire_reminder(request: Request):
    # Reminders are delivered by OpenClaw's own cron/heartbeat, not this UI.
    return {"ok": True}


def _write(note: dict):
    vs.ensure_dir(NOTES_DIR)
    content = note.pop("content", "") or ""
    note["content"] = content  # keep for the returned object
    meta = {k: v for k, v in note.items() if k != "content"}
    try:
        vs.save_entry(_path(note["id"]), meta, content)
    except Exception:  # noqa: BLE001 - fsutil now raises on write failure
        # (Task 10, fsutil.atomic_write_text). Without this catch the route
        # boundary was an unhandled 500 with no logging; worse, a caller that
        # didn't check the body could mistake it for a saved note. Log +
        # return an honest error the frontend's fetch handling already
        # understands (the `.error` key, same shape as the "not found" 404s
        # elsewhere in this router).
        log.error("vault write failed saving note %s", note.get("id"), exc_info=True)
        return JSONResponse({"error": "write failed"}, status_code=500)
    return JSONResponse(note)
