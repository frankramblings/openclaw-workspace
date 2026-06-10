"""Read-only WORKSPACE explorer endpoints (Hermes UI right pane).

Serves a size-annotated tree of the OpenClaw agent workspace (the same root
the Notes/Documents vault adapters use: ``vault_store.WORKSPACE``) and
individual file contents. Read-only by construction — GET routes only,
path-traversal guarded (symlink-aware).
"""
from __future__ import annotations

import mimetypes
import subprocess
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, PlainTextResponse

from . import vault_store as vs

router = APIRouter()

MAX_DEPTH = 6
MAX_ENTRIES = 2000
PREVIEW_CAP = 512 * 1024  # bytes of text served inline
CACHE_TTL = 10.0          # seconds; the 2014-mini disk hates re-walks
SKIP_CONTENTS = {".git", "node_modules", "__pycache__", ".venv", ".versions"}
TEXT_EXTS = {
    ".md", ".txt", ".json", ".py", ".js", ".mjs", ".ts", ".css", ".html",
    ".sh", ".yaml", ".yml", ".toml", ".ini", ".csv", ".log", ".skill",
}

_cache: dict = {"t": 0.0, "data": None}


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


def build_tree(root: Path, max_depth: int = MAX_DEPTH,
               max_entries: int = MAX_ENTRIES) -> tuple[list[dict], bool]:
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
        for p in entries:
            if state["count"] >= max_entries:
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
                if not is_link and p.name not in SKIP_CONTENTS and not p.name.startswith("."):
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


@router.get("/api/workspace/tree")
def workspace_tree(fresh: int = 0):
    now = time.time()
    if not fresh and _cache["data"] is not None and now - _cache["t"] < CACHE_TTL:
        return _cache["data"]
    root = workspace_root()
    if not root.is_dir():
        data = {"root": str(root), "branch": None, "tree": [],
                "truncated": False, "missing": True}
    else:
        tree, truncated = build_tree(root)
        data = {"root": str(root), "branch": git_branch(root), "tree": tree,
                "truncated": truncated, "missing": False}
    _cache.update(t=now, data=data)
    return data


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
