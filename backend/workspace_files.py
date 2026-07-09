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

# Text-file suffix policy for reads under the `home` root. The `workspace` root
# stays permissive (you own it); `home` exposes `$HOME` and needs guardrails so
# a browser session on the tailnet can't read credential material. Two checks:
# (1) suffix (or extensionless basename) must be on the allowlist below;
# (2) even then, a small denylist of "text-formatted secrets" refuses hard.
# After both pass, the read path still applies the UTF-8 + size guard.
_HOME_TEXT_SUFFIXES = {
    # Prose / markdown / notebooks
    ".md", ".markdown", ".mdx", ".txt", ".text", ".rst", ".adoc", ".org",
    ".tex", ".ltx", ".bib", ".sty", ".cls", ".rmd", ".qmd", ".ipynb",
    # Structured data / config
    ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg",
    ".conf", ".properties", ".csv", ".tsv", ".xml", ".xsd", ".xsl", ".xslt",
    ".plist", ".opml", ".rss", ".atom",
    # IDL / schema
    ".proto", ".thrift", ".capnp", ".fbs", ".graphql", ".gql", ".prisma",
    ".smithy", ".openapi", ".asyncapi",
    # Web / markup
    ".html", ".htm", ".xhtml", ".css", ".scss", ".sass", ".less", ".styl",
    ".svg", ".vue", ".svelte", ".astro",
    # Shell / scripting
    ".sh", ".bash", ".zsh", ".fish", ".ksh", ".csh", ".ps1", ".psm1",
    ".psd1", ".bat", ".cmd", ".awk", ".sed",
    # Mainstream code
    ".py", ".pyi", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".coffee",
    ".rb", ".erb", ".rbs",
    ".go", ".rs", ".c", ".h", ".cc", ".cpp", ".hpp", ".cxx", ".hxx",
    ".m", ".mm", ".swift",
    ".java", ".kt", ".kts", ".scala", ".groovy", ".clj", ".cljs", ".cljc", ".edn",
    ".ex", ".exs", ".erl", ".hrl", ".elm", ".ml", ".mli", ".hs", ".lhs", ".purs",
    ".nim", ".cr", ".zig", ".d", ".dart", ".lua", ".tcl", ".pl", ".pm",
    ".r", ".jl",
    ".fs", ".fsi", ".fsx", ".cs", ".csx", ".vb", ".vbs",
    # DB / query
    ".sql", ".psql", ".cql",
    # Diffs / patches / logs
    ".diff", ".patch", ".log", ".out", ".err",
    # Subtitles / captions
    ".srt", ".vtt", ".ass", ".ssa", ".sub",
    # Build files (extension form)
    ".gradle", ".sbt", ".gemspec", ".rockspec", ".nimble", ".opam", ".cabal",
    # Backups
    ".bak", ".old", ".orig", ".new", ".tmp", ".swp",
    # Misc
    ".skill", ".editorconfig", ".gitignore", ".gitattributes", ".gitmodules",
}

# Extensionless files with these basenames are always readable under `home`.
_HOME_TEXT_BASENAMES = {
    "readme", "changelog", "license", "notice", "authors", "contributors",
    "version", "todo", "copying",
    "makefile", "gnumakefile", "dockerfile", "containerfile",
    "brewfile", "gemfile", "rakefile", "podfile", "fastfile", "vagrantfile",
    "procfile", "justfile", "pipfile", "cargofile",
}

# Text-formatted credential material. Always refused under `home`, even if a
# broader suffix would have allowed it.
_HOME_DENY_SUFFIXES = {
    ".env", ".pem", ".key", ".p12", ".pfx", ".crt", ".cer", ".der",
    ".jwk", ".asc", ".gpg", ".pgp", ".kbx",
}
_HOME_DENY_BASENAMES = {
    ".netrc", ".pgpass", ".htpasswd", ".env", "authorized_keys",
    "known_hosts", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
}

# Whole directories where every file is a secret regardless of extension —
# suffix-allowlists can't catch e.g. `share-passkeys.json` or `gcloud.json`.
_HOME_DENY_PATH_PREFIXES = (
    ".ssh/",
    ".gnupg/",
    ".aws/",
    ".docker/",
    ".kube/",
    ".mcp-auth/",
    ".config/openclaw-secrets/",
    ".config/gh/",
    ".config/gcloud/",
    ".config/1Password/",
    ".config/rclone/",
    ".config/restic/",
    ".openclaw/gateway/secrets/",
    ".openclaw/secrets/",
    ".claude/oauth_tokens/",
)


def _home_text_ok(target: Path, rel_from_home: str = "") -> bool:
    """Suffix/basename + path-prefix policy for reads under the `home` root."""
    rel = rel_from_home.lstrip("/")
    for pref in _HOME_DENY_PATH_PREFIXES:
        if rel == pref.rstrip("/") or rel.startswith(pref):
            return False
    name = target.name
    lname = name.lower()
    if lname in _HOME_DENY_BASENAMES:
        return False
    suf = target.suffix.lower()
    if suf in _HOME_DENY_SUFFIXES:
        return False
    if suf:
        return suf in _HOME_TEXT_SUFFIXES
    return lname in _HOME_TEXT_BASENAMES


_cache: dict = {}  # (root_key, hidden_flag) -> (timestamp, data); cleared on any mutation


def workspace_root() -> Path:
    return vs.WORKSPACE


# Read-only roots the explorer can walk with `root_key`. Mutations remain
# workspace-only — this is intentionally a small allowlist of Frank's normal
# working directories, NOT arbitrary filesystem browsing.
def _allowed_roots() -> dict[str, Path]:
    home = Path.home()
    return {
        "workspace": workspace_root(),
        "home": home,
        "meetings": home / "meetings",
        "openclaw-workspace": home / "openclaw-workspace",
        "tmp": Path("/tmp"),
    }


def _root_for_key(key: str | None) -> tuple[str, Path]:
    """Return (key, path). Falls back to workspace on unknown/missing key."""
    roots = _allowed_roots()
    if key and key in roots:
        p = roots[key]
        if p.is_dir():
            return key, p
    return "workspace", workspace_root()


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


@router.get("/api/workspace/roots")
def workspace_roots():
    """List of root keys the explorer can browse (read-only outside workspace)."""
    out = []
    for k, p in _allowed_roots().items():
        out.append({
            "key": k,
            "path": str(p),
            "available": p.is_dir(),
            "mutable": k == "workspace",
        })
    return {"roots": out, "default": "workspace"}


@router.get("/api/workspace/tree")
def workspace_tree(fresh: int = 0, hidden: int = 0, root_key: str = "workspace"):
    key_hidden = bool(hidden)
    root_key, root = _root_for_key(root_key)
    cache_key = (root_key, key_hidden)
    now = time.time()
    ent = _cache.get(cache_key)
    if not fresh and ent is not None and now - ent[0] < CACHE_TTL:
        return ent[1]
    if not root.is_dir():
        data = {"root": str(root), "root_key": root_key, "branch": None,
                "dirty": False, "tree": [], "truncated": False, "missing": True,
                "mutable": root_key == "workspace"}
    else:
        tree, truncated = build_tree(root, include_hidden=key_hidden)
        data = {"root": str(root), "root_key": root_key,
                "branch": git_branch(root),
                "dirty": git_dirty(root), "tree": tree,
                "truncated": truncated, "missing": False,
                "mutable": root_key == "workspace"}
    _cache[cache_key] = (now, data)
    return data


class FileWriteBody(BaseModel):
    path: str
    content: str
    # Optional optimistic-concurrency guard. When the editor loaded the file it
    # captured mtime_ns; passing it back here lets the server reject a stale
    # save with 409 instead of silently clobbering a change made by Gary (or by
    # another tab) between load and save.
    if_mtime_ns: int | None = None

@router.put("/api/workspace/file")
def workspace_file_write(body: FileWriteBody):
    target = _mutable_or_400(body.path)
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    if target.suffix.lower() in _BINARY_EXTS:
        # Refuse to overwrite a binary file with editor text — that would
        # corrupt it. Images/PDFs/etc. are viewed, not text-edited.
        raise HTTPException(status_code=415, detail="not a text-editable file")
    # Mtime guard: if the caller told us what mtime they saw, and disk is now
    # newer, refuse. Tolerate 1s of clock skew (some filesystems only stamp to
    # seconds). Missing/None = caller didn't opt in → legacy behavior.
    if body.if_mtime_ns is not None:
        try:
            current_ns = target.stat().st_mtime_ns
        except OSError:
            current_ns = None
        if current_ns is not None and current_ns > body.if_mtime_ns + 1_000_000_000:
            raise HTTPException(
                status_code=409,
                detail={"error": "conflict", "current_mtime_ns": current_ns},
            )
    target.write_text(body.content, encoding="utf-8")
    try:
        new_ns = target.stat().st_mtime_ns
    except OSError:
        new_ns = 0
    # Best-effort notify any watchers — the inotify tail will also fire, but
    # broadcasting here gives us sub-100ms latency to the editor that just saved.
    try:
        from . import workspace_watch as ww
        ww.publish_change(str(target), new_ns)
    except Exception:
        pass
    return {"ok": True, "mtime_ns": new_ns}

@router.get("/api/workspace/file")
def workspace_file(path: str, root_key: str = "workspace"):
    resolved_key, root = _root_for_key(root_key)
    try:
        target = resolve_safe(root, path)
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid path")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="not a file")
    # Guardrail: `home` root exposes all of $HOME, so gate reads to known-safe
    # text file types (see _home_text_ok) — refuses credential files even when
    # they're text-formatted (~/.ssh/id_ed25519, ~/.aws/credentials, .env, …).
    # `workspace` and named sub-roots stay permissive.
    if resolved_key == "home":
        try:
            rel_from_home = target.resolve().relative_to(root.resolve()).as_posix()
        except (OSError, ValueError):
            rel_from_home = ""
        if not _home_text_ok(target, rel_from_home):
            raise HTTPException(status_code=403, detail="not permitted under home root")
    try:
        mtime_ns = target.stat().st_mtime_ns
    except OSError:
        mtime_ns = 0
    mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
    if mime.startswith("image/"):
        return FileResponse(target, media_type=mime,
                            headers={"X-Mtime-Ns": str(mtime_ns)})
    if target.suffix.lower() in TEXT_EXTS or mime.startswith("text/"):
        data = target.read_bytes()
        headers = {"X-Mtime-Ns": str(mtime_ns)}
        if len(data) > PREVIEW_CAP:
            headers["X-Truncated"] = "1"
        return PlainTextResponse(
            data[:PREVIEW_CAP].decode("utf-8", "replace"), headers=headers)
    return FileResponse(target, media_type=mime, filename=target.name,
                        headers={"X-Mtime-Ns": str(mtime_ns)})


# ---------------------------------------------------------------------------
# Task progress feed
# ---------------------------------------------------------------------------
# Any background job Gary promises to report on writes
# share/tasks/<id>/progress.json in the schema documented at
# docs/task-progress-schema.md. The PWA polls this endpoint to inject live
# status rows into the activity trail of the message that started each task.

# Terminal-state grace period: how long a done/failed task stays visible after
# its last update before we stop returning it. Client can still fetch by id.
_TASK_TERMINAL_GRACE_SEC = 60
# Ignore task files older than this if still running — stale writers.
_TASK_MAX_AGE_SEC = 24 * 3600


@router.get("/api/tasks/active")
def tasks_active(session_key: str | None = None):
    """Return every share/tasks/*/progress.json that is running, or done/failed
    within the last _TASK_TERMINAL_GRACE_SEC seconds. Optionally filter by
    sessionKey so a chat session only sees its own tasks."""
    import json as _json
    root = workspace_root()
    tdir = root / "share" / "tasks"
    if not tdir.is_dir():
        return {"tasks": []}
    now = time.time()
    out = []
    for entry in tdir.iterdir():
        if not entry.is_dir():
            continue
        pj = entry / "progress.json"
        if not pj.is_file():
            continue
        try:
            st = pj.stat()
            data = _json.loads(pj.read_bytes())
        except Exception:
            continue
        status = str(data.get("status") or "").lower()
        age = now - st.st_mtime
        if status in ("done", "failed"):
            if age > _TASK_TERMINAL_GRACE_SEC:
                continue
        elif status == "running":
            if age > _TASK_MAX_AGE_SEC:
                continue
        else:
            continue
        if session_key and data.get("sessionKey") and data.get("sessionKey") != session_key:
            continue
        out.append(data)
    # Sort newest-first by startedAt / updatedAt fallback
    out.sort(key=lambda d: d.get("updatedAt") or d.get("startedAt") or "", reverse=True)
    return {"tasks": out}
