"""Atomic read/merge/write of the cortex entity override JSON + denylist.

These are the SAME files verify_entities.py consults, so a decision made in the
inbox sticks: a verified/denylisted entity never reappears. Canonicalization and
schema mirror verify_entities.py exactly.
"""
from __future__ import annotations

import json
import os
import re
import threading
from pathlib import Path

from . import settings

OVERRIDES_NAME = "People_Pending_Overrides.json"
DENYLIST_NAME = "Entity_Denylist.md"
_LOCK = threading.Lock()


def _base(base: Path | None) -> Path:
    return Path(base) if base is not None else settings.entities_dir()


def canon_name(name: str) -> str:
    return re.sub(r"[-\s]+$", "", (name or "").strip()).lower()


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def load_overrides(base: Path | None = None) -> dict[str, dict]:
    path = _base(base) / OVERRIDES_NAME
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    out: dict[str, dict] = {}
    for k, v in (raw or {}).items():
        out[canon_name(k)] = {
            "type": str((v or {}).get("type", "person")) or "person",
            "verified": bool((v or {}).get("verified", False)),
        }
    return out


def _save_overrides(base: Path, data: dict[str, dict]) -> None:
    payload = {k: {"type": v["type"], "verified": bool(v["verified"])}
               for k, v in sorted(data.items())}
    _atomic_write(_base(base) / OVERRIDES_NAME,
                  json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def set_override(canon: str, etype: str, verified: bool = True,
                 base: Path | None = None) -> dict | None:
    with _LOCK:
        b = _base(base)
        data = load_overrides(b)
        c = canon_name(canon)
        prior = dict(data[c]) if c in data else None
        data[c] = {"type": etype, "verified": bool(verified)}
        _save_overrides(b, data)
        return prior


def restore_override(canon: str, prior: dict | None,
                     base: Path | None = None) -> None:
    with _LOCK:
        b = _base(base)
        data = load_overrides(b)
        c = canon_name(canon)
        if prior is None:
            data.pop(c, None)
        else:
            data[c] = {"type": str(prior.get("type", "person")),
                       "verified": bool(prior.get("verified", False))}
        _save_overrides(b, data)


def _denylist_lines(base: Path) -> list[str]:
    path = _base(base) / DENYLIST_NAME
    try:
        return path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return []


def load_denylist(base: Path | None = None) -> set[str]:
    out: set[str] = set()
    for line in _denylist_lines(_base(base)):
        m = re.match(r"^-\s+(.+)$", line.strip())
        if m:
            out.add(canon_name(m.group(1)))
    return out


def append_denylist(name: str, base: Path | None = None) -> bool:
    with _LOCK:
        b = _base(base)
        if canon_name(name) in load_denylist(b):
            return False
        path = _base(b) / DENYLIST_NAME
        body = ""
        try:
            body = path.read_text(encoding="utf-8")
        except Exception:
            body = "# Entity Denylist (Noise / Suppress)\n\n"
        if body and not body.endswith("\n"):
            body += "\n"
        body += f"- {name.strip()}\n"
        _atomic_write(path, body)
        return True


def remove_denylist(name: str, base: Path | None = None) -> None:
    with _LOCK:
        b = _base(base)
        path = _base(b) / DENYLIST_NAME
        target = canon_name(name)
        kept = []
        for line in _denylist_lines(b):
            m = re.match(r"^-\s+(.+)$", line.strip())
            if m and canon_name(m.group(1)) == target:
                continue
            kept.append(line)
        _atomic_write(path, "\n".join(kept) + ("\n" if kept else ""))
