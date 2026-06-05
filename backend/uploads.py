"""Minimal file upload for Notes/Documents image attachments.

Files are stored under `~/.openclaw/workspace/.attachments/<id><ext>` (inside
the agent vault, so the agent can see them too). The frontend uploads a
`files` field and expects `{files: [{id}]}`, then references the image at
`GET /api/upload/{id}`.
"""
from __future__ import annotations

import mimetypes
from pathlib import Path

from fastapi import APIRouter, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from . import vault_store as vs

router = APIRouter()

ATTACH_DIR = vs.WORKSPACE / ".attachments"


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


@router.get("/api/upload/{file_id}")
async def serve(file_id: str):
    safe = "".join(c for c in file_id if c.isalnum() or c in "-_.")
    path = ATTACH_DIR / safe
    if not path.exists() or not path.is_file():
        return JSONResponse({"error": "not found"}, status_code=404)
    ctype = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return FileResponse(str(path), media_type=ctype)
