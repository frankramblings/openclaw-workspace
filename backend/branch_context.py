"""Pending-context store for message-level Branch.

When a new session is branched from an existing one, we cannot replay the
prefix into the gateway (chat.inject renders everything as assistant). Instead
we hold the prefix here, workspace-side. The frontend renders the prefix from
the source session's cache; when Frank sends his first message into the new
session, the composer path calls consume() and prepends a compact preamble to
Frank's outgoing text so Gary has the context.

One JSON file per branched new-session id. Override the directory in tests via
env var OPENCLAW_BRANCH_CONTEXT_DIR.
"""
from __future__ import annotations
import json, os, tempfile
from pathlib import Path

_DEFAULT_DIR = Path(__file__).resolve().parent.parent / "data" / "branch_context"


def _dir() -> Path:
    override = os.environ.get("OPENCLAW_BRANCH_CONTEXT_DIR")
    p = Path(override) if override else _DEFAULT_DIR
    p.mkdir(parents=True, exist_ok=True)
    return p


def _path(new_session_id: str) -> Path:
    safe = new_session_id.replace("/", "_")
    return _dir() / f"{safe}.json"


def write(new_session_id: str, source_session_id: str,
          prefix: list[dict], preamble: str) -> None:
    payload = {"source_session_id": source_session_id,
               "prefix": prefix, "preamble": preamble}
    p = _path(new_session_id)
    # atomic write
    fd, tmp = tempfile.mkstemp(prefix=".ctx-", dir=str(p.parent))
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(payload, f)
        os.replace(tmp, p)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def read(new_session_id: str) -> dict | None:
    p = _path(new_session_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None


def consume(new_session_id: str) -> dict | None:
    p = _path(new_session_id)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    try:
        p.unlink()
    except OSError:
        pass
    return data
