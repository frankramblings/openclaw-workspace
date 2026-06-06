"""Documents tab → markdown files in the agent vault
(`~/.openclaw/workspace/Documents`).

Backs the Odysseus Documents editor. Each doc is one `.md` file: metadata
(title, language, session_id, version_count, is_active, …) in frontmatter, the
editable text as the body (`current_content`). Saves snapshot the previous body
into `Documents/.versions/<id>/v<n>.md` so the version-history UI works.

Frontend contract (js/document.js, js/documentLibrary.js):
  POST   /api/document                       {session_id,title,content,language} -> doc
  GET    /api/document/{id}                   -> doc (current_content populated)
  PUT    /api/document/{id}                    {content} -> doc (version_count bumped)
  DELETE /api/document/{id}
  POST   /api/document/{id}/archive?archived=true|false
  GET    /api/documents/{session_id}           -> [doc, ...]
  GET    /api/documents/library?sort&offset&limit&search&language&archived
                                               -> {documents,total,languages,session_count}
  GET    /api/document/{id}/versions           -> [{version,updated_at}, ...]
  GET    /api/document/{id}/version/{n}         -> doc at version n
  POST   /api/document/{id}/restore/{n}         -> doc
PDF import/export/render are stubbed (501) — not supported by the vault store.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import tempfile

from fastapi import APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse
from starlette.background import BackgroundTask

from . import vault_store as vs

router = APIRouter()

DOCS_DIR = vs.WORKSPACE / "Documents"
VERSIONS_DIR = DOCS_DIR / ".versions"

_META_KEYS = (
    "id", "title", "language", "session_id", "session_name",
    "version_count", "is_active", "archived", "created", "updated_at",
    "source_email_uid", "source_email_folder",
    "source_email_account_id", "source_email_message_id",
)


def _safe(doc_id: str) -> str:
    return "".join(c for c in str(doc_id) if c.isalnum() or c in "-_")


def _path(doc_id: str):
    return DOCS_DIR / f"{_safe(doc_id)}.md"


def _load(doc_id: str) -> dict | None:
    p = _path(doc_id)
    if not p.exists():
        return None
    return vs.load_entry(p, content_key="current_content")


def _write(doc: dict):
    vs.ensure_dir(DOCS_DIR)
    body = doc.get("current_content", "") or ""
    meta = {k: doc[k] for k in _META_KEYS if k in doc}
    vs.save_entry(_path(doc["id"]), meta, body)
    doc["current_content"] = body
    return doc


def _snapshot(doc: dict):
    vdir = vs.ensure_dir(VERSIONS_DIR / _safe(doc["id"]))
    n = doc.get("version_count", 1)
    vs.save_entry(vdir / f"v{n}.md", {"version": n, "updated_at": doc.get("updated_at", "")},
                  doc.get("current_content", ""))


def _preview(text: str, n: int = 200) -> str:
    return (text or "").strip()[:n]


@router.post("/api/document")
async def create_document(request: Request):
    body = await request.json()
    doc = {
        "id": vs.new_id(),
        "title": body.get("title", ""),
        "language": body.get("language", "markdown"),
        "session_id": body.get("session_id", ""),
        "session_name": body.get("session_name", ""),
        "current_content": body.get("content", "") or "",
        "version_count": 1,
        "is_active": True,
        "archived": False,
        "created": vs.now_iso(),
        "updated_at": vs.now_iso(),
    }
    return JSONResponse(_write(doc))


# NOTE: register /api/documents/library BEFORE /api/documents/{session_id} so
# the literal path wins over the path param.
@router.get("/api/documents/library")
async def library(sort: str = "recent", offset: int = 0, limit: int = 50,
                  search: str = "", language: str = "", archived: str | None = None):
    want_archived = str(archived).lower() == "true"
    docs = []
    if DOCS_DIR.exists():
        for p in DOCS_DIR.glob("*.md"):
            try:
                docs.append(vs.load_entry(p, content_key="current_content"))
            except Exception:
                continue
    docs = [d for d in docs if bool(d.get("archived")) == want_archived]
    if search:
        s = search.lower()
        docs = [d for d in docs
                if s in (d.get("title", "").lower()) or s in (d.get("current_content", "").lower())]
    if language:
        docs = [d for d in docs if d.get("language") == language]

    languages: dict[str, int] = {}
    sessions: set[str] = set()
    for d in docs:
        languages[d.get("language", "")] = languages.get(d.get("language", ""), 0) + 1
        if d.get("session_id"):
            sessions.add(d["session_id"])

    if sort == "alpha":
        docs.sort(key=lambda d: d.get("title", "").lower())
    else:
        docs.sort(key=lambda d: d.get("updated_at", ""), reverse=True)

    page = docs[offset:offset + limit]
    out = [{
        "id": d.get("id"),
        "title": d.get("title", ""),
        "language": d.get("language", ""),
        "preview": _preview(d.get("current_content", "")),
        "updated_at": d.get("updated_at", ""),
        "version_count": d.get("version_count", 1),
        "session_name": d.get("session_name", ""),
        "session_id": d.get("session_id", ""),
    } for d in page]
    return {"documents": out, "total": len(docs), "languages": languages,
            "session_count": len(sessions)}


@router.get("/api/documents/{session_id}")
async def list_session_docs(session_id: str):
    docs = []
    if DOCS_DIR.exists():
        for p in DOCS_DIR.glob("*.md"):
            try:
                d = vs.load_entry(p, content_key="current_content")
            except Exception:
                continue
            if d.get("session_id") == session_id and d.get("is_active", True) and not d.get("archived"):
                docs.append(d)
    docs.sort(key=lambda d: d.get("updated_at", ""), reverse=True)
    return docs


@router.get("/api/document/{doc_id}")
async def get_document(doc_id: str):
    doc = _load(doc_id)
    if doc is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return doc


@router.put("/api/document/{doc_id}")
async def save_document(doc_id: str, request: Request):
    body = await request.json()
    doc = _load(doc_id)
    if doc is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    _snapshot(doc)  # keep the prior body before overwriting
    if "content" in body:
        doc["current_content"] = body["content"]
    if "title" in body:
        doc["title"] = body["title"]
    if "language" in body:
        doc["language"] = body["language"]
    doc["version_count"] = doc.get("version_count", 1) + 1
    doc["updated_at"] = vs.now_iso()
    return JSONResponse(_write(doc))


@router.delete("/api/document/{doc_id}")
async def delete_document(doc_id: str):
    p = _path(doc_id)
    if p.exists():
        p.unlink()
    return {"ok": True}


@router.post("/api/document/{doc_id}/archive")
async def archive_document(doc_id: str, archived: str = "true"):
    doc = _load(doc_id)
    if doc is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    doc["archived"] = str(archived).lower() == "true"
    doc["is_active"] = not doc["archived"]
    return JSONResponse(_write(doc))


@router.get("/api/document/{doc_id}/versions")
async def list_versions(doc_id: str):
    vdir = VERSIONS_DIR / _safe(doc_id)
    out = []
    if vdir.exists():
        for p in sorted(vdir.glob("v*.md")):
            try:
                m, _ = vs.parse_frontmatter(p.read_text(encoding="utf-8"))
                out.append({"version": m.get("version"), "updated_at": m.get("updated_at", "")})
            except Exception:
                continue
    return out


@router.get("/api/document/{doc_id}/version/{num}")
async def get_version(doc_id: str, num: int):
    p = VERSIONS_DIR / _safe(doc_id) / f"v{num}.md"
    if not p.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    doc = _load(doc_id) or {"id": doc_id}
    _, body = vs.parse_frontmatter(p.read_text(encoding="utf-8"))
    doc["current_content"] = body
    return doc


@router.post("/api/document/{doc_id}/restore/{num}")
async def restore_version(doc_id: str, num: int):
    p = VERSIONS_DIR / _safe(doc_id) / f"v{num}.md"
    doc = _load(doc_id)
    if doc is None or not p.exists():
        return JSONResponse({"error": "not found"}, status_code=404)
    _snapshot(doc)
    _, body = vs.parse_frontmatter(p.read_text(encoding="utf-8"))
    doc["current_content"] = body
    doc["version_count"] = doc.get("version_count", 1) + 1
    doc["updated_at"] = vs.now_iso()
    return JSONResponse(_write(doc))


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
    try:
        proc = await asyncio.to_thread(
            subprocess.run,
            [pandoc, "-f", "markdown", "-t", "docx", "-o", out.name],
            input=(doc.get("current_content") or "").encode("utf-8"),
            capture_output=True, timeout=60)
    except Exception as exc:  # noqa: BLE001 - e.g. TimeoutExpired; don't orphan the tmp
        os.unlink(out.name)
        return JSONResponse({"error": f"pandoc failed: {exc!r}"}, status_code=500)
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


# --- PDF import/export not supported by the vault store ---------------------
@router.post("/api/documents/import-pdf")
async def import_pdf():
    return JSONResponse({"error": "PDF import not supported in the vault store"}, status_code=501)
