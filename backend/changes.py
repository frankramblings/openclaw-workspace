"""Per-turn change review: which files did Gary change, and what was there
before? Filesystem observation, tool-agnostic and git-free.

Per watched root we keep an index (relpath -> mtime_ns, size, sha256) and a
content-addressed blob cache holding the LAST SEEN content of every indexed
text file. refresh_index() diffs a fresh stat walk against the index, hashes
what moved, stores new blobs, and reports {added, modified, deleted} with the
before/after hashes. Turn attribution (who changed it) lives in the turn
functions further down (Task 2). Gary's workspace has huge untracked trees
(venvs, tmp/, plugins/), so the walk prunes by directory name and the cache
only holds text files up to max_bytes."""
from __future__ import annotations

import difflib
import fnmatch
import hashlib
import logging
import os
import re
import threading
import time
from pathlib import Path

from . import config, fsutil

log = logging.getLogger("changes")
_LOCK = threading.RLock()

DEFAULT_CONFIG = {
    "roots": [
        "/home/frank/.openclaw/workspace",
        "/home/frank/openclaw-workspace",
        "/home/frank/code/podcast-agent",
        "/home/frank/meetings",
        "/home/frank/.openclaw/openclaw.json",
    ],
    "prune_dirs": [
        ".git", "node_modules", ".venv*", ".venv_*", "__pycache__", ".tmp", ".trash",
        "tmp", "plugins", "mcp", ".attachments", ".chat-attachments",
        ".openclaw-cli-images", ".pi", ".clawhub",
    ],
    "skip_ext": [
        ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".mp4", ".mov", ".mkv",
        ".wav", ".mp3", ".m4a", ".pdf", ".zip", ".tar", ".gz", ".sqlite", ".db",
        ".bin", ".pyc", ".woff", ".woff2", ".ttf", ".lock",
    ],
    "max_bytes": 262144,
}


# --- paths -------------------------------------------------------------------

def _base() -> Path:
    return Path(config.DATA_DIR) / "changes"


def _config_path() -> Path:
    return Path(config.DATA_DIR) / "changes.json"


def root_key(root: str) -> str:
    return hashlib.sha1(os.path.abspath(root).encode("utf-8")).hexdigest()[:16]


def index_path(root: str) -> Path:
    return _base() / "index" / f"{root_key(root)}.json"


def blob_path(sha: str) -> Path:
    return _base() / "blobs" / sha[:2] / sha


def read_blob(sha: str | None) -> bytes | None:
    if not sha:
        return None
    p = blob_path(sha)
    try:
        return p.read_bytes()
    except OSError:
        return None


# --- config ------------------------------------------------------------------

def load_config() -> dict:
    p = _config_path()
    cfg = fsutil.load_json_guarded(p, None, logger=log)
    if not isinstance(cfg, dict):
        cfg = {k: (list(v) if isinstance(v, list) else v) for k, v in DEFAULT_CONFIG.items()}
        save_config(cfg)
    for k, v in DEFAULT_CONFIG.items():
        cfg.setdefault(k, list(v) if isinstance(v, list) else v)
    return cfg


def save_config(cfg: dict) -> None:
    p = _config_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    fsutil.atomic_write_json(p, cfg)


# --- scanning ----------------------------------------------------------------

def _pruned(name: str, patterns: list[str]) -> bool:
    return any(fnmatch.fnmatch(name, pat) for pat in patterns)


def scan_root(root: str, cfg: dict) -> dict[str, tuple[int, int]]:
    """relpath -> (mtime_ns, size) for every candidate file under `root`."""
    out: dict[str, tuple[int, int]] = {}
    max_bytes = int(cfg.get("max_bytes") or DEFAULT_CONFIG["max_bytes"])
    skip_ext = {e.lower() for e in cfg.get("skip_ext") or []}
    prune = list(cfg.get("prune_dirs") or [])
    root = os.path.abspath(root)
    if os.path.isfile(root):
        try:
            st = os.stat(root)
        except OSError:
            return out
        if st.st_size <= max_bytes and os.path.splitext(root)[1].lower() not in skip_ext:
            out[os.path.basename(root)] = (st.st_mtime_ns, st.st_size)
        return out
    if not os.path.isdir(root):
        return out
    stack = [root]
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                entries = list(it)
        except OSError:
            continue
        for e in entries:
            try:
                if e.is_symlink():
                    continue
                if e.is_dir(follow_symlinks=False):
                    if not _pruned(e.name, prune):
                        stack.append(e.path)
                    continue
                if not e.is_file(follow_symlinks=False):
                    continue
                if os.path.splitext(e.name)[1].lower() in skip_ext:
                    continue
                st = e.stat(follow_symlinks=False)
            except OSError:
                continue
            if st.st_size > max_bytes:
                continue
            out[os.path.relpath(e.path, root)] = (st.st_mtime_ns, st.st_size)
    return out


# --- index + blobs -----------------------------------------------------------

def is_text(sample: bytes) -> bool:
    return b"\x00" not in sample[:8192]


def _load_index(root: str) -> dict:
    idx = fsutil.load_json_guarded(index_path(root), None, logger=log)
    if not isinstance(idx, dict) or not isinstance(idx.get("files"), dict):
        idx = {"root": os.path.abspath(root), "scanned_ms": 0, "files": {}}
    return idx


def _save_index(root: str, idx: dict) -> None:
    p = index_path(root)
    p.parent.mkdir(parents=True, exist_ok=True)
    fsutil.atomic_write_json(p, idx)


def _hash_and_store(abs_path: str) -> tuple[str | None, bool, int]:
    """(sha256 | None on read error, diffable, size). Stores a blob only for
    text content (binary is hashed for change detection, never cached)."""
    try:
        data = Path(abs_path).read_bytes()
    except OSError:
        return None, False, 0
    sha = hashlib.sha256(data).hexdigest()
    text = is_text(data)
    if text:
        bp = blob_path(sha)
        if not bp.exists():
            bp.parent.mkdir(parents=True, exist_ok=True)
            tmp = bp.with_suffix(".tmp")
            tmp.write_bytes(data)
            os.replace(tmp, bp)
    return sha, text, len(data)


def refresh_index(root: str, cfg: dict) -> list[dict]:
    """Bring the index for `root` up to date and return what changed since the
    previous refresh. The very first refresh seeds silently (returns [])."""
    root = os.path.abspath(root)
    with _LOCK:
        idx = _load_index(root)
        files = idx["files"]
        seeded = idx.get("scanned_ms", 0) == 0 and not files
        scan = scan_root(root, cfg)
        report: list[dict] = []
        seen = set()
        for rel, (mtime_ns, size) in scan.items():
            seen.add(rel)
            prev = files.get(rel)
            if prev and prev[0] == mtime_ns and prev[1] == size:
                continue
            sha, diffable, nbytes = _hash_and_store(os.path.join(root, rel))
            if sha is None:
                continue
            if prev and prev[2] == sha:
                files[rel] = [mtime_ns, size, sha]      # touched, same content
                continue
            files[rel] = [mtime_ns, size, sha]
            if not seeded:
                before = prev[2] if prev else None
                report.append({
                    "path": rel,
                    "kind": "modified" if prev else "added",
                    "before_sha": before, "after_sha": sha,
                    "before_bytes": (prev[1] if prev else 0), "after_bytes": nbytes,
                    "diffable": diffable and (before is None or read_blob(before) is not None),
                })
        for rel in list(files):
            if rel in seen:
                continue
            prev = files.pop(rel)
            if not seeded:
                report.append({
                    "path": rel, "kind": "deleted",
                    "before_sha": prev[2], "after_sha": None,
                    "before_bytes": prev[1], "after_bytes": 0,
                    "diffable": read_blob(prev[2]) is not None,
                })
        idx["scanned_ms"] = int(time.time() * 1000)
        _save_index(root, idx)
        return report


# --- turn attribution ----------------------------------------------------------

DIFF_MAX_LINES = 4000
_SAFE = re.compile(r"[^A-Za-z0-9_.-]")
# (session_key, turn_id) -> {"started_ms": int, "pending": [file dicts]}
_ACTIVE: dict[tuple[str, int], dict] = {}


def safe_key(session_key: str) -> str:
    return _SAFE.sub("_", session_key or "")[:120] or "_"


def record_path(session_key: str, turn_id: int) -> Path:
    return _base() / "turns" / safe_key(session_key) / f"{int(turn_id)}.json"


def _line_counts(before: bytes | None, after: bytes | None) -> tuple[int, int]:
    b = before.decode("utf-8", "replace").splitlines() if before else []
    a = after.decode("utf-8", "replace").splitlines() if after else []
    added = removed = 0
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, b, a, autojunk=False).get_opcodes():
        if tag in ("replace", "delete"):
            removed += i2 - i1
        if tag in ("replace", "insert"):
            added += j2 - j1
    return added, removed


def _decorate(change: dict, root: str) -> dict:
    before = read_blob(change.get("before_sha")) if change.get("diffable") else None
    after = read_blob(change.get("after_sha")) if change.get("diffable") else None
    added, removed = _line_counts(before, after) if change.get("diffable") else (0, 0)
    return {**change, "root": root, "added": added, "removed": removed,
            "shared": False, "reverted": False}


def turn_started(session_key: str, turn_id: int) -> None:
    """Absorb whatever changed since the last look (attributed to nobody) and
    open this turn's window."""
    cfg = load_config()
    with _LOCK:
        for root in cfg.get("roots") or []:
            try:
                refresh_index(root, cfg)
            except Exception:  # noqa: BLE001 - one bad root must not stop the rest
                log.warning("changes: refresh failed for %s", root, exc_info=True)
        _ACTIVE[(session_key, int(turn_id))] = {"started_ms": int(time.time() * 1000), "pending": []}


def turn_ended(session_key: str, turn_id: int) -> dict | None:
    """Close this turn's window: refresh every root, attribute what moved to
    every turn active right now (shared when more than one), persist records."""
    cfg = load_config()
    key = (session_key, int(turn_id))
    with _LOCK:
        me = _ACTIVE.pop(key, None) or {"started_ms": int(time.time() * 1000), "pending": []}
        others = list(_ACTIVE.keys())
        found: list[dict] = []
        for root in cfg.get("roots") or []:
            try:
                for ch in refresh_index(root, cfg):
                    found.append(_decorate(ch, os.path.abspath(root)))
            except Exception:  # noqa: BLE001
                log.warning("changes: refresh failed for %s", root, exc_info=True)
        shared = bool(others)
        for f in found:
            f["shared"] = shared
        for ok in others:
            _ACTIVE[ok]["pending"].extend(dict(f, shared=True) for f in found)
            _ACTIVE[ok].setdefault("shared_with", set()).add(session_key)
        files = list(me.get("pending") or []) + found
        shared_with = sorted(set(me.get("shared_with") or set()) | ({o[0] for o in others} if found else set()))
        rec = {"session_key": session_key, "turn_id": int(turn_id),
               "started_ms": me["started_ms"], "ended_ms": int(time.time() * 1000),
               "shared_with": [s for s in shared_with if s != session_key], "files": files}
        p = record_path(session_key, turn_id)
        p.parent.mkdir(parents=True, exist_ok=True)
        fsutil.atomic_write_json(p, rec)
        return rec


def turn_record(session_key: str, turn_id: int) -> dict | None:
    rec = fsutil.load_json_guarded(record_path(session_key, turn_id), None, logger=log)
    return rec if isinstance(rec, dict) else None


def session_turns(session_key: str) -> list[dict]:
    d = _base() / "turns" / safe_key(session_key)
    out = []
    if not d.is_dir():
        return out
    for p in d.glob("*.json"):
        rec = fsutil.load_json_guarded(p, None, logger=log)
        if not isinstance(rec, dict):
            continue
        files = rec.get("files") or []
        out.append({"turn_id": rec.get("turn_id"), "started_ms": rec.get("started_ms"),
                    "ended_ms": rec.get("ended_ms"), "files": len(files),
                    "added": sum(int(f.get("added") or 0) for f in files),
                    "removed": sum(int(f.get("removed") or 0) for f in files),
                    "shared": any(f.get("shared") for f in files)})
    out.sort(key=lambda r: (r["ended_ms"] or 0), reverse=True)
    return out


def diff_for(session_key: str, turn_id: int, path: str) -> dict:
    rec = turn_record(session_key, turn_id)
    f = next((x for x in (rec or {}).get("files", []) if x.get("path") == path), None)
    if not f:
        return {"diffable": False, "text": "", "before_bytes": 0, "after_bytes": 0, "kind": None}
    base = {"kind": f.get("kind"), "before_bytes": f.get("before_bytes", 0), "after_bytes": f.get("after_bytes", 0)}
    if not f.get("diffable"):
        return {**base, "diffable": False, "text": ""}
    before = read_blob(f.get("before_sha")) or b""
    after = read_blob(f.get("after_sha")) or b""
    lines = list(difflib.unified_diff(
        before.decode("utf-8", "replace").splitlines(keepends=True),
        after.decode("utf-8", "replace").splitlines(keepends=True),
        fromfile=f"a/{path}", tofile=f"b/{path}", n=3))
    text = "".join(lines)
    if len(lines) > DIFF_MAX_LINES:
        text = "".join(lines[:DIFF_MAX_LINES]) + "[diff truncated]\n"
    return {**base, "diffable": True, "text": text}
