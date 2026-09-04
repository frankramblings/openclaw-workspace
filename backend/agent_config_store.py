"""Local state for the agent-config surfaces (Pillar D): pre-write backups,
an append-only audit log, and the writes kill switch.

Everything lives under config.DATA_DIR/agent-config with 0700 directories
and 0600 files: backups of openclaw.json carry secrets, and the operator's home directory
grants another account --x, so directory modes are the real fence (the same
lesson the change tracker learned in its final review).

The gateway does its own writes atomically but keeps no previous version
(agents.files.set) or keeps one only for proposals (rollback.json), so the
backend snapshots the pre-write content itself before every write it asks
the gateway to make."""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .fsutil import atomic_write_text

logger = logging.getLogger(__name__)

BACKUP_KEEP_DEFAULT = 20
AUDIT_TAIL_BYTES = 64 * 1024
_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]")
_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{12}-[0-9a-f]{8}$")


def writes_enabled() -> bool:
    """Kill switch for every Pillar D write route. Off values mirror the
    other WORKSPACE_* flags in this codebase."""
    return os.environ.get("WORKSPACE_AGENT_CONFIG_WRITES", "1") not in ("0", "false", "no", "")


def _ensure_dir(d: Path) -> Path:
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError as exc:
        logger.warning("agent_config_store: could not chmod %s to 0700: %s", d, exc)
    return d


def base_dir() -> Path:
    return _ensure_dir(Path(config.DATA_DIR) / "agent-config")


def _write_private(path: Path, text: str) -> None:
    atomic_write_text(path, text)
    os.chmod(path, 0o600)


def key_slug(key: str) -> str:
    """One directory name per key: '/' becomes '__', anything outside
    [A-Za-z0-9._-] becomes '_'. Never empty, and never exactly '.' or '..'
    (either would resolve to an existing ancestor directory instead of a
    key-specific leaf)."""
    slug = _SLUG_RE.sub("_", key.replace("/", "__")) or "_"
    return "_" if slug in (".", "..") else slug


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _backup_dir(kind: str, key: str) -> Path:
    """backups/<kind>/<key>, with every level chmodded 0700: mkdir(parents=True)
    only sets the mode of the leaf it creates, and the service umask leaves
    the intermediate levels group/other-readable otherwise."""
    d = _ensure_dir(base_dir() / "backups")
    d = _ensure_dir(d / key_slug(kind))
    return _ensure_dir(d / key_slug(key))


def _prune(d: Path, keep: int) -> None:
    metas = sorted(d.glob("*.json"), key=lambda p: p.name, reverse=True)
    for meta in metas[max(0, keep):]:
        for victim in (meta, meta.with_suffix(".txt")):
            try:
                victim.unlink()
            except OSError:
                pass
    # backup() writes <id>.txt then <id>.json; a crash between the two writes
    # leaves an orphan .txt with no sibling .json, which the .json-driven
    # pruning above never sees (list_backups/read_backup are also keyed off
    # the .json). Sweep those orphans here too.
    json_stems = {p.stem for p in d.glob("*.json")}
    for txt in d.glob("*.txt"):
        if txt.stem not in json_stems:
            try:
                txt.unlink()
            except OSError:
                pass


def backup(kind: str, key: str, content: str, meta: dict | None = None,
           keep: int = BACKUP_KEEP_DEFAULT) -> dict:
    """Snapshot `content` under backups/<kind>/<key>/<id>.txt with a sibling
    .json entry; prune the key to the newest `keep`. Returns the entry."""
    d = _backup_dir(kind, key)
    now = datetime.now(timezone.utc)
    digest = sha256_text(content)
    bid = f"{now.strftime('%Y%m%dT%H%M%S%f')}-{digest[:8]}"
    entry = {"id": bid, "ts": now.isoformat(), "size": len(content.encode("utf-8")),
             "sha256": digest, "kind": kind, "key": key, "meta": dict(meta or {})}
    _write_private(d / f"{bid}.txt", content)
    _write_private(d / f"{bid}.json", json.dumps(entry, indent=2))
    _prune(d, keep)
    return entry


def list_backups(kind: str, key: str) -> list[dict]:
    d = base_dir() / "backups" / key_slug(kind) / key_slug(key)
    if not d.is_dir():
        return []
    out = []
    for meta in d.glob("*.json"):
        try:
            entry = json.loads(meta.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(entry, dict) and _ID_RE.match(str(entry.get("id", ""))):
            out.append(entry)
    out.sort(key=lambda e: e["id"], reverse=True)
    return out


def read_backup(kind: str, key: str, backup_id: str) -> str:
    """The backed-up content. FileNotFoundError for a malformed id (the id
    regex is the traversal guard) or a pruned / unknown backup."""
    if not _ID_RE.match(backup_id or ""):
        raise FileNotFoundError(backup_id)
    path = base_dir() / "backups" / key_slug(kind) / key_slug(key) / f"{backup_id}.txt"
    if not path.is_file():
        raise FileNotFoundError(backup_id)
    return path.read_text(encoding="utf-8")


def _audit_path() -> Path:
    return base_dir() / "audit.jsonl"


def audit(action: str, target: str, ok: bool, **fields) -> dict:
    """Append one JSON line {ts, action, target, ok, ...fields}. Never raises
    into a route: a failed audit write (disk full, read-only filesystem) is
    caught here and logged at warning; the gateway write, if any, already
    went through, so the route must not see an exception from this call."""
    entry = {"ts": datetime.now(timezone.utc).isoformat(), "action": action,
             "target": target, "ok": bool(ok), **fields}
    try:
        fd = os.open(_audit_path(), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        logger.warning("agent_config_store.audit: could not append audit line for %s %s: %s",
                       action, target, exc)
    return entry


def recent_audit(limit: int = 50) -> list[dict]:
    """Newest first, from the last AUDIT_TAIL_BYTES of the file; a torn final
    line (a crash mid-append) is skipped, not fatal."""
    path = _audit_path()
    if not path.is_file():
        return []
    limit = max(1, min(int(limit), 500))
    size = path.stat().st_size
    with open(path, "rb") as f:
        if size > AUDIT_TAIL_BYTES:
            f.seek(size - AUDIT_TAIL_BYTES)
            f.readline()
        data = f.read().decode("utf-8", "replace")
    out: list[dict] = []
    for raw in data.splitlines():
        raw = raw.strip()
        if not raw:
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        if isinstance(entry, dict):
            out.append(entry)
    out.reverse()
    return out[:limit]


def count_audit() -> int:
    path = _audit_path()
    if not path.is_file():
        return 0
    with open(path, "rb") as f:
        return sum(1 for line in f if line.strip())
