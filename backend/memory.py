"""Memories: the Odysseus memory panel, backed by OpenClaw's curated MEMORY.md.

OpenClaw's real curated memory is the heartbeat-maintained markdown at
~/.openclaw/workspace/memory/MEMORY.md — `## Section` headers over `- bullet`
facts. That maps directly onto the panel's typed-fact model (sections →
categories, bullets → memory items), so we read AND write that file: the panel
is a real view of (and editor for) the brain's curated memory.

`doctor.memory.status` was the obvious gateway source but returns only the ~8
"grounded short-term" entries — too sparse; MEMORY.md is the full curated set.

Mutations:
  - add  → insert a bullet under a "## User Notes" section (or the given
           category) and write back. The brain re-ingests on next maintenance.
  - edit → replace the matching bullet's lines in place.
  - delete → remove the matching bullet's lines.
  - pin  → no markdown equivalent, so it lives in a tiny workspace overlay.

Each item id is a stable hash of its text, so it survives line renumbering.

CAVEAT: the heartbeat periodically re-distills MEMORY.md; an edit made between
runs is honored but may later be consolidated. Writes are atomic (tmp+rename)
to avoid torn files if a maintenance run overlaps.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import tempfile
import time
from pathlib import Path

from fastapi import APIRouter, Body, Form, Request
from fastapi.responses import JSONResponse

from . import config, fsutil

_log = logging.getLogger(__name__)

router = APIRouter()

MEMORY_MD = Path(os.environ.get(
    "OPENCLAW_MEMORY_MD",
    config.OPENCLAW_HOME / "workspace" / "memory" / "MEMORY.md"))
USER_SECTION = "User Notes"
_OVERLAY = config.DATA_DIR / "memory_overlay.json"
_PREFS = config.DATA_DIR / "memory_prefs.json"
_BULLET = re.compile(r"^[-*]\s+(.*)$")


# --- small JSON-on-disk helpers ----------------------------------------------

def _read_json(path: Path, default):
    """Read JSON from disk, with asymmetric error handling.

    Corrupt JSON (JSONDecodeError, invalid UTF-8) is quarantined (elsewhere)
    and degrades to the default — no data is lost because corruption is
    detected and the user can recover from a quarantined .corrupt-* file.

    Missing file returns default; other OSErrors (PermissionError, EIO,
    IsADirectoryError) deliberately PROPAGATE. Several callers are
    read-modify-write: update_memory, delete_memory, pin_memory, put_pref.
    If a failed read degraded to default, the next write would overwrite the
    store with empty state — the exact data-loss class this task closes. A
    loud 500 is the safe failure here, unlike terminals.read_meta, which
    deliberately degrades because raising would 500 its routes and tear down
    the terminal WS (accepting a narrower meta-wipe risk).
    """
    return fsutil.load_json_guarded(path, default, logger=_log)


def _write_json(path: Path, data) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2))


def _atomic_write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), suffix=".tmp")
    try:
        with os.fdopen(fd, "w") as f:
            f.write(text)
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def _mid(text: str) -> str:
    return hashlib.md5(text.strip().encode()).hexdigest()[:12]


# --- MEMORY.md parsing -------------------------------------------------------

def _parse(md: str) -> list[dict]:
    """Parse MEMORY.md into blocks: {id, text, section, start, end} (line span)."""
    lines = md.splitlines()
    items: list[dict] = []
    section = "General"
    cur: dict | None = None

    def close():
        nonlocal cur
        if cur is not None:
            cur["text"] = "\n".join(cur.pop("_lines")).strip()
            cur["id"] = _mid(cur["text"])
            items.append(cur)
            cur = None

    for i, line in enumerate(lines):
        if line.startswith("## "):
            close()
            section = line[3:].strip()
            continue
        if line.startswith("# "):
            close()
            continue
        m = _BULLET.match(line)
        if m:
            close()
            cur = {"section": section, "_lines": [m.group(1)], "start": i, "end": i}
        elif cur is not None and line.strip() and (line.startswith((" ", "\t"))):
            cur["_lines"].append(line.strip())
            cur["end"] = i
        else:
            close()
    close()
    return items


def _load_md() -> str:
    try:
        return MEMORY_MD.read_text()
    except FileNotFoundError:
        return "# MEMORY.md\n"


def _to_item(block: dict, pinned: set[str], ts: int) -> dict:
    return {
        "id": block["id"],
        "text": block["text"],
        "category": block["section"],
        "pinned": block["id"] in pinned,
        "timestamp": ts,
        "uses": 0,
        "source": "MEMORY.md",
    }


def list_memories() -> list[dict]:
    blocks = _parse(_load_md())
    pinned = set(_read_json(_OVERLAY, {}).get("pinned", []))
    ts = int(MEMORY_MD.stat().st_mtime * 1000) if MEMORY_MD.exists() else 0
    return [_to_item(b, pinned, ts) for b in blocks]


# --- mutations ---------------------------------------------------------------

def add_memory(text: str, category: str | None = None) -> dict:
    text = text.strip()
    section = (category or USER_SECTION).strip()
    lines = _load_md().splitlines()
    bullet = f"- {text}"
    hdr = f"## {section}"
    idx = next((i for i, line in enumerate(lines) if line.strip() == hdr), None)
    if idx is None:
        if lines and lines[-1].strip():
            lines.append("")
        lines += [hdr, bullet]
    else:
        # insert after the section's last non-blank line (before the next ##/EOF)
        j = idx + 1
        while j < len(lines) and not lines[j].startswith("## "):
            j += 1
        while j - 1 > idx and not lines[j - 1].strip():
            j -= 1
        lines.insert(j, bullet)
    _atomic_write(MEMORY_MD, "\n".join(lines) + "\n")
    return {"id": _mid(text), "text": text, "category": section,
            "pinned": False, "timestamp": int(time.time() * 1000),
            "uses": 0, "source": "MEMORY.md"}


def update_memory(mid: str, text: str, category: str | None = None) -> dict | None:
    md = _load_md()
    block = next((b for b in _parse(md) if b["id"] == mid), None)
    if block is None:
        return None
    lines = md.splitlines()
    lines[block["start"]:block["end"] + 1] = [f"- {text.strip()}"]
    _atomic_write(MEMORY_MD, "\n".join(lines) + "\n")
    # carry the pin to the new id
    ov = _read_json(_OVERLAY, {})
    pins = set(ov.get("pinned", []))
    if mid in pins:
        pins.discard(mid)
        pins.add(_mid(text))
        ov["pinned"] = sorted(pins)
        _write_json(_OVERLAY, ov)
    return {"id": _mid(text), "text": text.strip(),
            "category": category or block["section"], "pinned": _mid(text) in pins,
            "timestamp": int(time.time() * 1000), "uses": 0, "source": "MEMORY.md"}


def delete_memory(mid: str) -> bool:
    md = _load_md()
    block = next((b for b in _parse(md) if b["id"] == mid), None)
    if block is not None:
        lines = md.splitlines()
        del lines[block["start"]:block["end"] + 1]
        _atomic_write(MEMORY_MD, "\n".join(lines).rstrip("\n") + "\n")
    ov = _read_json(_OVERLAY, {})
    if mid in set(ov.get("pinned", [])):
        ov["pinned"] = [x for x in ov["pinned"] if x != mid]
        _write_json(_OVERLAY, ov)
    return True


def pin_memory(mid: str, pinned: bool) -> None:
    ov = _read_json(_OVERLAY, {})
    pins = set(ov.get("pinned", []))
    pins.add(mid) if pinned else pins.discard(mid)
    ov["pinned"] = sorted(pins)
    _write_json(_OVERLAY, ov)


# --- routes ------------------------------------------------------------------

@router.get("/api/memory")
async def get_memory():
    return {"memory": list_memories()}


@router.post("/api/memory/add")
async def post_add(body: dict = Body(default=None)):
    text = ((body or {}).get("text") or "").strip()
    if not text:
        return JSONResponse(status_code=400, content={"detail": "text required"})
    return add_memory(text, (body or {}).get("category"))


@router.put("/api/memory/{mid}")
async def put_memory(mid: str, text: str = Form(...), category: str = Form(default=None)):
    item = update_memory(mid, text, category)
    if item is None:
        return JSONResponse(status_code=404, content={"detail": "no such memory"})
    return item


@router.delete("/api/memory/{mid}")
async def delete_memory_route(mid: str):
    return {"ok": delete_memory(mid)}


@router.post("/api/memory/{mid}/pin")
async def pin_memory_route(mid: str, pinned: str = Form(default="true")):
    val = str(pinned).lower() not in ("false", "0", "")
    pin_memory(mid, val)
    return {"ok": True, "pinned": val}


# Advanced ops the panel offers but OpenClaw has no primitive for: ack cleanly
# (returning the current list) so the buttons don't error.
@router.post("/api/memory/audit")
async def audit():
    return {"ok": True, "memory": list_memories()}


# --- extraction: REAL auto/manual memory extraction via the brain -------------
# Manual: the panel's "Extract memories from this session" button posts here and
# renders the returned `suggestions` in a review modal (user approves → add).
# Auto: app.chat_stream fires maybe_auto_extract() after each web turn; gated by
# the #auto-memory-toggle pref (`auto_memory`), a per-session cooldown, and
# dedupe against the existing curated set. Approved facts land in the brain's
# own MEMORY.md via add_memory(), so the agent itself benefits too.

_AUTO_COOLDOWN_S = 600.0
_AUTO_CATEGORY = "Auto-extracted"
_last_auto: dict[str, float] = {}


def _extract_session() -> str:
    """Utility thread for memory extraction (never a visible chat). Follows the
    derived agent id — for agent 'main' this is the v1 'agent:main:web-memex'."""
    return f"{config.web_session_prefix()}-memex"


def _norm(t: str) -> str:
    return re.sub(r"\s+", " ", t.strip().lower())


def _extract_prompt(transcript: str, existing: list[str]) -> str:
    known = "\n".join(f"- {t[:120]}" for t in existing[:60]) or "(none yet)"
    return (
        "You maintain a curated long-term memory about the user. From the "
        "conversation below, extract durable NEW facts worth remembering "
        "across sessions: stable preferences, decisions, projects, people, "
        "constraints. NOT task chatter, NOT one-off details, NOT anything "
        "already known.\n\n"
        f"Already known (do not repeat):\n{known}\n\n"
        f"Conversation:\n{transcript}\n\n"
        "Output ONLY '- ' bullet lines, one self-contained fact each, max 5. "
        "If there is nothing new and durable, output exactly: NONE"
    )


def auto_memory_enabled() -> bool:
    # The toggle ships checked in the UI, so an unset pref means enabled.
    val = _read_json(_PREFS, {}).get("auto_memory")
    return True if val is None else bool(val)


async def extract_suggestions(session_key: str, limit_msgs: int = 30) -> list[str]:
    """One brain turn over the session's recent transcript → novel fact list."""
    from . import bridge  # late import: bridge pulls websockets at import time

    hist = await bridge.fetch_history(session_key, limit=limit_msgs)
    msgs = hist.get("history") or []
    if not msgs:
        return []
    transcript = "\n".join(
        f"{m.get('role', '?')}: {str(m.get('content', ''))[:500]}"
        for m in msgs[-limit_msgs:])
    existing = {_norm(m["text"]) for m in list_memories()}
    raw = await bridge.run_text(
        _extract_prompt(transcript, sorted(existing)), _extract_session())
    out: list[str] = []
    for line in raw.splitlines():
        m = _BULLET.match(line.strip())
        if not m:
            continue
        fact = m.group(1).strip()
        if fact and _norm(fact) not in existing:
            out.append(fact)
    return out[:5]


async def maybe_auto_extract(session_key: str) -> None:
    """Background, best-effort: extract + directly add new facts. Cooldown is
    stamped up front so a stalled brain isn't re-hit every message.

    The whole body — including the auto_memory_enabled() toggle read, which
    can raise OSError on a prefs file that's unreadable — is inside the
    guard below: this is a detached background task, so any failure here
    must swallow rather than propagate."""
    try:
        if not auto_memory_enabled():
            return
        now = time.monotonic()
        if now - _last_auto.get(session_key, 0.0) < _AUTO_COOLDOWN_S:
            return
        _last_auto[session_key] = now
        for fact in await extract_suggestions(session_key, limit_msgs=16):
            add_memory(fact, category=_AUTO_CATEGORY)
    except Exception:  # noqa: BLE001 - never break or noise up the chat path
        pass


@router.post("/api/memory/extract")
async def extract(session: str = Form(default="")):
    from . import sessions_store
    rec = sessions_store.get(session) if session else None
    key = rec["sessionKey"] if rec else config.web_session_key()
    try:
        suggestions = await extract_suggestions(key)
    except Exception as exc:  # noqa: BLE001
        return JSONResponse(status_code=502, content={"ok": False, "error": f"{exc!r}"})
    return {"ok": True, "suggestions": suggestions,
            "added": 0, "memories": []}  # legacy keys some panel paths read


@router.post("/api/memory/import")
async def import_memories(request: Request):
    return {"ok": True, "imported": 0}


# --- prefs (panel toggles/sliders): tiny key→value store ---------------------

@router.get("/api/prefs/{key}")
async def get_pref(key: str):
    return {"key": key, "value": _read_json(_PREFS, {}).get(key)}


@router.put("/api/prefs/{key}")
async def put_pref(key: str, body: dict = Body(default=None)):
    prefs = _read_json(_PREFS, {})
    prefs[key] = (body or {}).get("value")
    _write_json(_PREFS, prefs)
    return {"ok": True, "key": key, "value": prefs[key]}
