"""Atomic writes + advisory file locking for the content stores.

The metadata stores (sessions_store.py) already write via tmp-file +
os.replace so a crash mid-write can't corrupt them; this module gives the
same durability guarantee to the *content* stores (vault_store, documents,
research, email_config), plus a flock-based advisory lock so our own
concurrent writers serialize instead of interleaving.

Scope limit — read this before assuming file_lock is a general mutex: the
vault markdown files are also written by a separate, out-of-process agent
that does its own file I/O and never takes this lock. flock() only
coordinates cooperating callers that go through file_lock() in *this*
process tree; it cannot stop the agent process from writing the same file
concurrently. This protects our side only.
"""
from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
import time
from pathlib import Path

_POLL_INTERVAL_S = 0.02


def atomic_write_text(path: Path, text: str) -> None:
    """Write `text` to `path` atomically.

    Writes to a tmp file in the same directory (so the final os.replace is
    same-filesystem and therefore atomic on POSIX), flushes + fsyncs it, then
    replaces the target in one step. If anything raises before the replace,
    the original file (if any) is left exactly as it was and the tmp file is
    removed — no partial writes, no litter."""
    path = Path(path)
    fd, tmp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_name, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def atomic_write_json(path: Path, obj) -> None:
    """json.dumps(obj) (human-diffable: ensure_ascii=False, indent=2) then
    atomic_write_text."""
    atomic_write_text(path, json.dumps(obj, ensure_ascii=False, indent=2))


@contextlib.contextmanager
def file_lock(path: Path, timeout: float = 5.0):
    """Advisory exclusive lock guarding writes to `path`, held on a
    `<path>.lock` sidecar (never on `path` itself, so it can't interfere with
    plain reads of the content file).

    flock() has no native timeout, so this polls for LOCK_EX|LOCK_NB and
    raises TimeoutError if it can't acquire within `timeout` seconds. Callers
    let that propagate — a stuck lock past the timeout is a real fault (e.g.
    a wedged process), not something to silently swallow."""
    path = Path(path)
    lock_path = path.parent / f"{path.name}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(lock_path, os.O_CREAT | os.O_RDWR, 0o600)
    deadline = time.monotonic() + timeout
    try:
        while True:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"timed out after {timeout}s waiting for lock on {path}") from None
                time.sleep(_POLL_INTERVAL_S)
        yield
    finally:
        fcntl.flock(fd, fcntl.LOCK_UN)
        os.close(fd)
