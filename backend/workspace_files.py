"""Read-only WORKSPACE explorer endpoints (Hermes UI right pane).

Serves a size-annotated tree of the OpenClaw agent workspace (the same root
the Notes/Documents vault adapters use: ``vault_store.WORKSPACE``) and
individual file contents. Read routes are GET; mutation routes are POST and
additionally refuse SKIP_CONTENTS segments and the workspace root itself.
"""
from __future__ import annotations

import io
import mimetypes
import os
import shutil
import subprocess
import time
import zipfile
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, PlainTextResponse, Response
from pydantic import BaseModel

from . import vault_store as vs

router = APIRouter()

MAX_DEPTH = 6
MAX_ENTRIES = 2000
MAX_PER_DIR = 200  # one 9k-file dir must not starve its siblings (depth-first walk)
PREVIEW_CAP = 512 * 1024  # bytes of text served inline
UPLOAD_CAP = 50 * 1024 * 1024   # bytes per uploaded file
ARCHIVE_CAP = 100 * 1024 * 1024  # uncompressed bytes per folder zip
CACHE_TTL = 10.0          # seconds; the 2014-mini disk hates re-walks
SKIP_CONTENTS = {".git", "node_modules", "__pycache__", ".venv", ".versions"}
TEXT_EXTS = {
    ".md", ".txt", ".json", ".py", ".js", ".mjs", ".ts", ".css", ".html",
    ".sh", ".yaml", ".yml", ".toml", ".ini", ".csv", ".log", ".skill",
}

# Extensions that are never text. Writing UTF-8 text over one of these (e.g. a
# text editor that opened a PNG via res.text() and saved it back) silently
# corrupts the file — every non-UTF-8 byte becomes the � replacement char. The
# PUT handler refuses these so an image can never be clobbered by an editor save.
_BINARY_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".avif", ".ico",
    ".pdf", ".zip", ".gz", ".tar", ".tgz", ".mp3", ".mp4", ".mov", ".wav",
    ".m4a", ".webm", ".woff", ".woff2", ".ttf", ".otf", ".eot",
}

_cache: dict = {}  # hidden_flag(bool) -> (timestamp, data); cleared on any mutation


def workspace_root() -> Path:
    return vs.WORKSPACE


def git_branch(root: Path) -> str | None:
    """Current branch name, or None for non-repos/any failure."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "rev-parse", "--abbrev-ref", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def git_dirty(root: Path) -> bool:
    """True when the workspace repo has uncommitted changes; False on any failure."""
    try:
        out = subprocess.run(
            ["git", "-C", str(root), "status", "--porcelain"],
            capture_output=True, text=True, timeout=5,
        )
    except Exception:
        return False
    return out.returncode == 0 and bool(out.stdout.strip())


def build_tree(root: Path, max_depth: int = MAX_DEPTH,
               max_entries: int = MAX_ENTRIES,
               max_per_dir: int = MAX_PER_DIR,
               include_hidden: bool = False) -> tuple[list[dict], bool]:
    """Nested {name,path,type,size,children} nodes + truncated flag.

    Dirs sort before files (case-insensitive). Entries in SKIP_CONTENTS are
    listed but never walked. Symlinks are never walked (a symlinked dir shows
    as a childless dir). Depth/entry caps set truncated=True when they bite.
    """
    state = {"count": 0, "truncated": False}

    def walk(d: Path, depth: int) -> list[dict]:
        nodes: list[dict] = []
        try:
            entries = sorted(d.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))
        except OSError:
            return nodes
        for i, p in enumerate(entries):
            if i >= max_per_dir or state["count"] >= max_entries:
                state["truncated"] = True
                break
            state["count"] += 1
            rel = p.relative_to(root).as_posix()
            is_link = p.is_symlink()
            if p.is_dir():
                node = {"name": p.name, "path": rel, "type": "dir", "children": []}
                # Hidden dirs are listed but never walked: the real workspace
                # root is dominated by .attachments/.clawhub/... whose contents
                # would eat the MAX_ENTRIES budget before any real dir renders.
                if not is_link and p.name not in SKIP_CONTENTS \
                        and (include_hidden or not p.name.startswith(".")):
                    if depth >= max_depth:
                        state["truncated"] = True
                    else:
                        node["children"] = walk(p, depth + 1)
                nodes.append(node)
            elif p.is_file():
                try:
                    size = p.stat().st_size
                except OSError:
                    size = 0
                nodes.append({"name": p.name, "path": rel, "type": "file", "size": size})
        return nodes

    if not root.is_dir():
        return [], False
    return walk(root, 1), state["truncated"]


def resolve_safe(root: Path, rel: str) -> Path:
    """Resolve ``rel`` strictly inside ``root`` (symlink-aware) or raise ValueError."""
    if not rel or rel.startswith(("/", "\\")) or "\x00" in rel:
        raise ValueError("invalid path")
    target = (root / rel).resolve()
    rootr = root.resolve()
    if target != rootr and rootr not in target.parents:
        raise ValueError("path escapes workspace root")
    return target


def resolve_mutable(root: Path, rel: str) -> Path:
    """`resolve_safe` plus mutation rails: never the workspace root itself and
    never inside a protected segment (.git, .versions, node_modules, ...) — the
    explorer must not be able to nuke vault history or repo internals, even
    past a confirm dialog. The target itself may not exist yet (create paths).
    """
    target = resolve_safe(root, rel)
    rootr = root.resolve()
    if target == rootr:
        raise ValueError("workspace root is not mutable")
    for seg in target.relative_to(rootr).parts:
        if seg in SKIP_CONTENTS:
            raise ValueError("protected path")
    return target


class PathBody(BaseModel):
    path: str


def _invalidate_cache() -> None:
    _cache.clear()


def _mutable_or_400(rel: str) -> Path:
    try:
        return resolve_mutable(workspace_root(), rel)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/api/workspace/create")
def workspace_create(body: PathBody):
    target = _mutable_or_400(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.touch()
    _invalidate_cache()
    return {"ok": True, "path": body.path}


@router.post("/api/workspace/mkdir")
def workspace_mkdir(body: PathBody):
    target = _mutable_or_400(body.path)
    if target.exists():
        raise HTTPException(status_code=409, detail="already exists")
    target.mkdir(parents=True, exist_ok=True)
    _invalidate_cache()
    return {"ok": True, "path": body.path}


class RenameBody(BaseModel):
    path: str
    new_name: str


class MoveBody(BaseModel):
    path: str
    dest_dir: str = ""


@router.post("/api/workspace/rename")
def workspace_rename(body: RenameBody):
    rootr = workspace_root().resolve()
    src = _mutable_or_400(body.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="not found")
    name = body.new_name.strip()
    if (not name or "/" in name or "\\" in name or "\x00" in name
            or name in (".", "..") or name in SKIP_CONTENTS):
        raise HTTPException(status_code=400, detail="invalid name")
    dst = src.with_name(name)
    if dst.exists():
        raise HTTPException(status_code=409, detail="target exists")
    src.rename(dst)
    _invalidate_cache()
    return {"ok": True, "path": dst.relative_to(rootr).as_posix()}


@router.post("/api/workspace/move")
def workspace_move(body: MoveBody):
    rootr = workspace_root().resolve()
    src = _mutable_or_400(body.path)
    if not src.exists():
        raise HTTPException(status_code=404, detail="not found")
    dd = body.dest_dir.strip().strip("/")
    dest = rootr if dd in ("", ".") else _mutable_or_400(dd)
    if not dest.is_dir():
        raise HTTPException(status_code=404, detail="destination is not a directory")
    if dest == src or src in dest.parents:
        raise HTTPException(status_code=400, detail="cannot move a folder into itself")
    dst = dest / src.name
    if dst.exists():
        raise HTTPException(status_code=409, detail="target exists")
    shutil.move(str(src), str(dst))
    _invalidate_cache()
    return {"ok": True, "path": dst.relative_to(rootr).as_posix()}


@router.post("/api/workspace/delete")
def workspace_delete(body: PathBody):
    target = _mutable_or_400(body.path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="not found")
    if target.is_dir():
        shutil.rmtree(target)
    else:
        target.unlink()
    _invalidate_cache()
    return {"ok": True}


def _dedupe_name(p: Path) -> Path:
    """Finder-style collision suffix: a.txt -> a (1).txt -> a (2).txt ..."""
    if not p.exists():
        return p
    for i in range(1, 1000):
        cand = p.with_name(f"{p.stem} ({i}){p.suffix}")
        if not cand.exists():
            return cand
    raise HTTPException(status_code=409, detail="too many name collisions")


@router.post("/api/workspace/upload")
async def workspace_upload(files: list[UploadFile] = File(...),
                           dest: str = Form("", alias="dir")):
    rootr = workspace_root().resolve()
    dd = dest.strip().strip("/")
    target_dir = rootr if dd in ("", ".") else _mutable_or_400(dd)
    if target_dir.exists() and not target_dir.is_dir():
        raise HTTPException(status_code=400, detail="destination is not a directory")
    target_dir.mkdir(parents=True, exist_ok=True)  # folder drops create paths
    saved = []
    for f in files:
        data = await f.read()
        if len(data) > UPLOAD_CAP:
            raise HTTPException(status_code=413,
                                detail=f"{f.filename} exceeds 50MB upload cap")
        name = Path(f.filename or "upload").name  # strip any client-sent path
        target = _dedupe_name(target_dir / name)
        target.write_bytes(data)
        saved.append(target.relative_to(rootr).as_posix())
    _invalidate_cache()
    return {"ok": True, "saved": saved}


@router.get("/api/workspace/archive")
def workspace_archive(path: str):
    """Zip a workspace folder for download. Prunes SKIP_CONTENTS, refuses
    oversize folders (the 2014 mini builds the zip in RAM)."""
    root = workspace_root()
    try:
        target = resolve_safe(root, path)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="not a directory")
    total = 0
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = [d for d in dirnames
                           if d not in SKIP_CONTENTS
                           and not Path(dirpath, d).is_symlink()]
            for fn in sorted(filenames):
                p = Path(dirpath) / fn
                if p.is_symlink() or not p.is_file():
                    continue
                total += p.stat().st_size
                if total > ARCHIVE_CAP:
                    raise HTTPException(status_code=413,
                                        detail="folder too large to zip")
                zf.write(p, p.relative_to(target.parent).as_posix())
    return Response(
        buf.getvalue(), media_type="application/zip",
        headers={"Content-Disposition":
                 f'attachment; filename="{target.name}.zip"'})


@router.get("/api/workspace/tree")
def workspace_tree(fresh: int = 0, hidden: int = 0):
    key = bool(hidden)
    now = time.time()
    ent = _cache.get(key)
    if not fresh and ent is not None and now - ent[0] < CACHE_TTL:
        return ent[1]
    root = workspace_root()
    if not root.is_dir():
        data = {"root": str(root), "branch": None, "dirty": False, "tree": [],
                "truncated": False, "missing": True}
    else:
        tree, truncated = build_tree(root, include_hidden=key)
        data = {"root": str(root), "branch": git_branch(root),
                "dirty": git_dirty(root), "tree": tree,
                "truncated": truncated, "missing": False}
    _cache[key] = (now, data)
    return data


class FileWriteBody(BaseModel):
    path: str
    content: str

@router.put("/api/workspace/file")
def workspace_file_write(body: FileWriteBody):
    target = _mutable_or_400(body.path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    if target.suffix.lower() in _BINARY_EXTS:
        # Refuse to overwrite a binary file with editor text — that would
        # corrupt it. Images/PDFs/etc. are viewed, not text-edited.
        raise HTTPException(status_code=415, detail="not a text-editable file")
    target.write_text(body.content, encoding="utf-8")
    return {"ok": True}

@router.get("/api/workspace/file")
def workspace_file(path: str):
    root = workspace_root()
    try:
        target = resolve_safe(root, path)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if mime.startswith("image/"):
        return FileResponse(target, media_type=mime)
    if target.suffix.lower() in TEXT_EXTS or mime.startswith("text/"):
        data = target.read_bytes()
        headers = {"X-Truncated": "1"} if len(data) > PREVIEW_CAP else {}
        return PlainTextResponse(
            data[:PREVIEW_CAP].decode("utf-8", "replace"), headers=headers)
    return FileResponse(target, media_type=mime, filename=target.name)
