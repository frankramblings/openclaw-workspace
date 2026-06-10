"""Minimal file upload for Notes/Documents image attachments.

Files are stored under `~/.openclaw/workspace/.attachments/<id><ext>` (inside
the agent vault, so the agent can see them too). The frontend uploads a
`files` field and expects `{files: [{id}]}`, then references the image at
`GET /api/upload/{id}`.
"""
from __future__ import annotations

import json
import mimetypes
import os
import re
import tempfile
from pathlib import Path

from fastapi import APIRouter, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from . import config
from . import vault_store as vs

router = APIRouter()

ATTACH_DIR = vs.WORKSPACE / ".attachments"

# Where the gateway persists images the AGENT shares back (managed outgoing
# attachments). Each is a JSON record pointing at the original file on disk.
OUTGOING_RECORDS = config.OPENCLAW_HOME / "media" / "outgoing" / "records"
_ATTACH_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$")


def _media_roots() -> list[Path]:
    """Directories a `MEDIA:<path>` reply may serve an image from. Mirrors
    OpenClaw's own local-media allowlist (src/media/local-roots.ts): the agent
    vault + media/canvas/sandbox dirs under ~/.openclaw, plus the OS temp dir.
    Anything outside these is refused — the agent only ever points MEDIA: at
    files it produced in these locations."""
    home = config.OPENCLAW_HOME
    roots = [home / "workspace", home / "media", home / "canvas",
             home / "sandboxes", ATTACH_DIR, Path(tempfile.gettempdir())]
    out: list[Path] = []
    for r in roots:
        try:
            out.append(r.resolve())
        except OSError:
            continue
    return out


@router.post("/api/upload")
async def upload(files: list[UploadFile] = None):
    vs.ensure_dir(ATTACH_DIR)
    saved = []
    for f in files or []:
        ext = Path(f.filename or "").suffix[:12]
        fid = vs.new_id() + ext
        (ATTACH_DIR / fid).write_bytes(await f.read())
        saved.append({"id": fid, "name": f.filename, "url": f"/api/upload/{fid}"})
    return {"files": saved}


@router.get("/api/chat/media/outgoing/{session_key}/{attachment_id}/full")
async def outgoing_image(session_key: str, attachment_id: str):
    """Serve an image the AGENT shared back to the user.

    When the agent emits an image, the gateway saves it as a "managed outgoing
    attachment" under ~/.openclaw/media/outgoing/ and puts a content block in the
    final chat event whose `url` is exactly THIS path. The gateway also serves it,
    but only behind operator HTTP auth the browser can't supply — so the SPA loads
    it from us (same origin) instead. We resolve the on-disk record and stream the
    original bytes. `session_key` must match the record (light ownership check);
    FastAPI hands us the value already URL-decoded (the gateway encodes the ':')."""
    if not _ATTACH_ID_RE.match(attachment_id):
        return JSONResponse({"error": "not found"}, status_code=404)
    try:
        record = json.loads((OUTGOING_RECORDS / f"{attachment_id}.json").read_text())
    except (FileNotFoundError, ValueError, OSError):
        return JSONResponse({"error": "not found"}, status_code=404)
    if record.get("sessionKey") != session_key:
        return JSONResponse({"error": "not found"}, status_code=404)
    original = record.get("original") or {}
    src = original.get("path")
    if not src or not Path(src).is_file():
        return JSONResponse({"error": "missing media"}, status_code=404)
    ctype = (original.get("contentType")
             or mimetypes.guess_type(src)[0] or "application/octet-stream")
    return FileResponse(src, media_type=ctype)


@router.get("/api/workspace-media")
async def workspace_media(path: str):
    """Serve an image file the AGENT shared via a `MEDIA:<path>` reply line.

    OpenClaw's convention is that `MEDIA:<abs-path>` on its own line requests the
    web UI to render that file inline (it's the agent's documented way to share
    an existing image — e.g. `MEDIA:~/.openclaw/workspace/avatars/x.png`). The
    frontend rewrites such lines to `<img src=/api/workspace-media?path=…>`; we
    resolve the path, enforce it's an image under an allowed media root (no
    traversal, no arbitrary filesystem reads), and stream it."""
    try:
        target = Path(path).expanduser().resolve()
    except (OSError, RuntimeError, ValueError):
        return JSONResponse({"error": "bad path"}, status_code=400)
    roots = _media_roots()
    if not any(target == r or str(target).startswith(str(r) + os.sep) for r in roots):
        return JSONResponse({"error": "forbidden"}, status_code=403)
    if not target.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    if not ctype.startswith("image/"):
        return JSONResponse({"error": "not an image"}, status_code=415)
    return FileResponse(str(target), media_type=ctype)


@router.get("/api/upload/{file_id}")
async def serve(file_id: str):
    safe = "".join(c for c in file_id if c.isalnum() or c in "-_.")
    path = ATTACH_DIR / safe
    if not path.exists() or not path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return FileResponse(str(path), media_type=ctype)
