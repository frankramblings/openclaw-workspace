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

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from . import vault_store as vs

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
    notes = [n for n in _load_all() if bool(n.get("archived")) == want_archived]
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
        vs.save_entry(path, note, content)
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
    vs.save_entry(_path(note["id"]), meta, content)
    return JSONResponse(note)
