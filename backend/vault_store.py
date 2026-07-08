"""Shared helpers for storing Notes/Documents as markdown files in the
OpenClaw agent vault (`~/.openclaw/workspace`).

Why files-in-the-vault: the vault IS the agent's working directory
(`agents.defaults.workspace` in openclaw.json), so anything the web UI saves
here becomes agent-readable context — and anything the agent writes shows up in
the UI. We store one `.md` file per entry with a small frontmatter block for
structured fields and the markdown body as the editable content.

Frontmatter is intentionally dependency-free (no PyYAML — the launchd service
runs system python and we don't want to depend on its site-packages): each line
is `key: <json>`, which round-trips arbitrary types and still reads as valid
YAML-ish frontmatter for Obsidian.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path

from . import config
from .fsutil import atomic_write_text, file_lock

WORKSPACE = config.OPENCLAW_HOME / "workspace"


def new_id() -> str:
    return uuid.uuid4().hex[:12]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def parse_frontmatter(text: str) -> tuple[dict, str]:
    """Split `---`-delimited frontmatter from the markdown body."""
    meta: dict = {}
    if text.startswith("---"):
        lines = text.split("\n")
        close = None
        for i in range(1, len(lines)):
            if lines[i].strip() == "---":
                close = i
                break
        if close is not None:
            for ln in lines[1:close]:
                if not ln.strip() or ": " not in ln:
                    continue
                k, v = ln.split(": ", 1)
                try:
                    meta[k.strip()] = json.loads(v)
                except Exception:
                    meta[k.strip()] = v
            body = "\n".join(lines[close + 1:])
            return meta, body[1:] if body.startswith("\n") else body
    return meta, text


def dump_frontmatter(meta: dict, body: str) -> str:
    out = ["---"]
    for k, v in meta.items():
        out.append(f"{k}: {json.dumps(v, ensure_ascii=False)}")
    out.append("---")
    return "\n".join(out) + "\n" + (body or "")


def load_entry(path: Path, content_key: str = "content") -> dict:
    """Read a vault `.md` file into a dict: frontmatter fields + the body under
    `content_key`."""
    meta, body = parse_frontmatter(path.read_text(encoding="utf-8"))
    meta[content_key] = body
    return meta


def save_entry(path: Path, meta: dict, body: str) -> None:
    with file_lock(path):
        atomic_write_text(path, dump_frontmatter(meta, body))
