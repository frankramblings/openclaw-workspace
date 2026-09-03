"""Projects store (spec §4.2): the grouping layer over sessions. A session's
`folder` field holds a project id from here. Same shape of store as
sessions_store: one JSON file, a process lock, atomic writes."""
from __future__ import annotations

import json
import logging
import os
import threading
import time
import uuid

from . import config, fsutil

log = logging.getLogger(__name__)

_LOCK = threading.Lock()
_STORE_FILE = config.DATA_DIR / "projects.json"
SCHEMA_VERSION = 1
_ALLOWED_UPDATE = {"name", "archived", "hints"}


def _now_ms() -> int:
    return int(time.time() * 1000)


def _load() -> dict:
    data = fsutil.load_json_guarded(_STORE_FILE, {"projects": []}, logger=log)
    if not isinstance(data.get("projects"), list):
        data["projects"] = []
    return data


def _save(data: dict) -> None:
    data["schema_version"] = SCHEMA_VERSION
    _STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = _STORE_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=2))
    os.replace(tmp, _STORE_FILE)


def _norm(name: str) -> str:
    return " ".join(str(name or "").split()).strip().lower()


def list_projects() -> list[dict]:
    with _LOCK:
        items = list(_load()["projects"])
    return sorted(items, key=lambda p: p.get("updated", 0), reverse=True)


def get(pid: str) -> dict | None:
    with _LOCK:
        for p in _load()["projects"]:
            if p.get("id") == pid:
                return p
    return None


def find_by_name(name: str) -> dict | None:
    key = _norm(name)
    if not key:
        return None
    with _LOCK:
        for p in _load()["projects"]:
            if _norm(p.get("name")) == key:
                return p
    return None


def create(name: str, hints: list[str] | None = None, archived: bool = False) -> dict:
    clean = " ".join(str(name or "").split()).strip()
    if not clean:
        raise ValueError("empty")
    with _LOCK:
        data = _load()
        if any(_norm(p.get("name")) == _norm(clean) for p in data["projects"]):
            raise ValueError("duplicate")
        now = _now_ms()
        rec = {
            "id": "p-" + uuid.uuid4().hex[:8],
            "name": clean,
            "created": now,
            "updated": now,
            "archived": bool(archived),
            "hints": [str(h).strip().lower() for h in (hints or []) if str(h).strip()],
        }
        data["projects"].append(rec)
        _save(data)
    return rec


def update(pid: str, **fields) -> dict | None:
    with _LOCK:
        data = _load()
        for p in data["projects"]:
            if p.get("id") != pid:
                continue
            if "name" in fields:
                clean = " ".join(str(fields["name"] or "").split()).strip()
                if not clean:
                    raise ValueError("empty")
                if any(q.get("id") != pid and _norm(q.get("name")) == _norm(clean) for q in data["projects"]):
                    raise ValueError("duplicate")
                fields["name"] = clean
            for k, v in fields.items():
                if k in _ALLOWED_UPDATE:
                    p[k] = bool(v) if k == "archived" else v
            p["updated"] = _now_ms()
            _save(data)
            return p
    return None


def delete(pid: str) -> bool:
    with _LOCK:
        data = _load()
        before = len(data["projects"])
        data["projects"] = [p for p in data["projects"] if p.get("id") != pid]
        if len(data["projects"]) != before:
            _save(data)
            return True
    return False
