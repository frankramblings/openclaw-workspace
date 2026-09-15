"""Live tail of a still-running Bash tool call.

The gateway only reports a tool call twice — start, then result — so while a
long command runs the PWA has nothing to show. A PreToolUse hook
(`~/.claude/hooks/toolstream-tee.py`) tees each Bash command's output into
`.data/toolstream/<tool_use_id>.log`, and that id is the same one the gateway
puts on its tool_start frame. This module serves those bytes back so an
expanded running step can poll for them.

Read-only, byte-offset based: the client sends the offset it has already
consumed and gets whatever arrived since. A file that does not exist yet is a
normal state (the command may not have produced output), not an error.
"""
from __future__ import annotations

import re
from pathlib import Path

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from . import config

router = APIRouter()

# Ids come from the model's tool_use blocks (`toolu_…`). Anchored and
# conservative: this value becomes a filename.
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

MAX_CHUNK = 64 * 1024   # bytes served per poll
MAX_LINES = 400         # …and lines, so a chatty command can't flood the UI


def log_dir() -> Path:
    return config.DATA_DIR / "toolstream"


def _resolve(tool_id: str) -> Path | None:
    """Map an id to its log path, or None if the id is not well-formed.

    The regex already excludes separators and dots, so the joined path cannot
    escape the directory; the resolve() check below is belt-and-braces against
    a future loosening of the pattern.
    """
    if not _ID_RE.match(tool_id):
        return None
    base = log_dir().resolve()
    path = (base / f"{tool_id}.log").resolve()
    if not str(path).startswith(str(base) + "/"):
        return None
    return path


@router.get("/api/toolstream/{tool_id}")
async def tail(tool_id: str, offset: int = 0):
    """Return output written after `offset` for this tool call.

    Always 200 with a usable shape — a missing log means "nothing yet", which
    is what a command that has not printed anything looks like. Reporting that
    as an error would make the UI cry wolf on every silent command.
    """
    path = _resolve(tool_id)
    if path is None:
        return JSONResponse(status_code=400, content={"error": "bad tool id"})
    if not path.exists():
        return {"lines": [], "offset": 0, "available": False}

    size = path.stat().st_size
    start = max(0, min(offset, size))
    # A shrinking file means the log was rotated or reaped under us; restart
    # from the beginning rather than serving a slice from the wrong place.
    if offset > size:
        start = 0
    truncated = False
    if size - start > MAX_CHUNK:
        start = size - MAX_CHUNK
        truncated = True
    try:
        with path.open("rb") as fh:
            fh.seek(start)
            raw = fh.read(MAX_CHUNK)
    except OSError:
        return {"lines": [], "offset": offset, "available": False}

    # A trailing fragment is a partially-written line; keep it out of the
    # rendered list but do NOT consume it, so the next poll returns it whole.
    # Measure in raw bytes: re-encoding decoded text miscounts invalid UTF-8.
    consumed = raw.rfind(b"\n") + 1
    lines = raw[:consumed].decode("utf-8", "replace").split("\n")[:-1]

    omitted = 0
    if len(lines) > MAX_LINES:
        omitted = len(lines) - MAX_LINES
        lines = lines[-MAX_LINES:]

    return {
        "lines": lines,
        "offset": start + consumed,
        "available": True,
        "omitted": omitted,
        "truncated": truncated,
    }
