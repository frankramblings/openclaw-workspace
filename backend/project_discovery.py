"""Project discovery: propose projects for a tenant that has none.

One local-model call over recent thread titles produces a PROPOSAL file.
Nothing here creates a project; the Settings card turns a proposal into a
project only when the person clicks Accept (see projects.py)."""
from __future__ import annotations

import asyncio
import json
import logging
import re
import time
import uuid

from . import config, fsutil, local_llm, project_classify, projects_store, sessions_store

log = logging.getLogger(__name__)

PROPOSAL_FILE_NAME = "projects_proposal.json"
MIN_SESSIONS = 12
MAX_PROPOSALS = 8
MIN_COUNT = 3
MAX_TITLES = 400
MAX_NAME = 40
_LOCK = asyncio.Lock()
_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def _path():
    return config.DATA_DIR / PROPOSAL_FILE_NAME


def _empty() -> dict:
    return {"schema_version": 1, "created": 0, "model": "", "proposals": [], "error": None}


def load_proposals() -> dict:
    data = fsutil.load_json_guarded(_path(), None, logger=log)
    if not isinstance(data, dict) or not isinstance(data.get("proposals"), list):
        return _empty()
    out = _empty()
    out.update({k: data.get(k) for k in ("created", "model", "error") if k in data})
    out["proposals"] = [p for p in data["proposals"] if isinstance(p, dict) and p.get("id")]
    return out


def save_proposals(data: dict) -> None:
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    fsutil.atomic_write_json(_path(), data)


def remove_proposal(pid: str) -> dict | None:
    data = load_proposals()
    keep, gone = [], None
    for p in data["proposals"]:
        if p.get("id") == pid and gone is None:
            gone = p
        else:
            keep.append(p)
    if gone is not None:
        data["proposals"] = keep
        save_proposals(data)
    return gone


def running() -> bool:
    return _LOCK.locked()


def _recent_titles(since_days: int) -> list[str]:
    cutoff = int(time.time() * 1000) - int(since_days) * 86400 * 1000
    rows = [s for s in sessions_store.list_sessions()
            if not s.get("archived") and (s.get("updated") or s.get("created") or 0) >= cutoff]
    rows.sort(key=lambda s: s.get("updated") or s.get("created") or 0, reverse=True)
    seen, out = set(), []
    for s in rows:
        t = " ".join(str(s.get("name") or "").split()).strip()
        if not t or t.lower() in seen:
            continue
        seen.add(t.lower())
        out.append(t)
        if len(out) >= MAX_TITLES:
            break
    return out


def should_discover(since_days: int = 90) -> bool:
    """True only for a tenant with no projects, no seed file, no proposal file,
    and enough recent threads to say something about."""
    if projects_store.list_projects():
        return False
    if (config.DATA_DIR / project_classify.SEED_FILE_NAME).exists():
        return False
    if _path().exists():
        return False
    return len(_recent_titles(since_days)) >= MIN_SESSIONS


def build_prompt(titles: list[str]) -> str:
    listing = "\n".join(f"- {t[:120]}" for t in titles)
    return (
        "Below are titles of recent chat threads from one person. Group them into "
        f"at most {MAX_PROPOSALS} projects. A project needs at least {MIN_COUNT} titles. "
        "Skip anything that does not clearly belong to a project.\n\n"
        "Return ONLY a JSON object of this shape, no prose:\n"
        '{"projects": [{"name": "Short project name", "hints": ["3 to 6 lowercase keywords"], '
        '"titles": ["exact titles from the list that belong here"]}]}\n\n'
        f"Titles:\n{listing}\n"
    )


def parse_proposals(raw: str, titles: list[str]) -> list[dict]:
    text = (raw or "").strip()
    if not text:
        return []
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    start = text.find("{")
    if start < 0:
        return []
    try:
        data = json.loads(text[start:text.rfind("}") + 1])
    except ValueError:
        return []
    items = data.get("projects") if isinstance(data, dict) else None
    if not isinstance(items, list):
        return []
    known = {t.lower(): t for t in titles}
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        name = " ".join(str(it.get("name") or "").split()).strip()[:MAX_NAME]
        if not name or name.lower() in seen:
            continue
        if projects_store.find_by_name(name):
            continue
        raw_titles = it.get("titles") if isinstance(it.get("titles"), list) else []
        matched: list[str] = []
        for t in raw_titles:
            k = " ".join(str(t or "").split()).strip().lower()
            if k in known and known[k] not in matched:
                matched.append(known[k])
        if len(matched) < MIN_COUNT:
            continue
        hints_raw = it.get("hints") if isinstance(it.get("hints"), list) else []
        hints: list[str] = []
        for h in hints_raw:
            hk = str(h or "").strip().lower()
            if hk and hk not in hints:
                hints.append(hk)
        seen.add(name.lower())
        out.append({
            "id": "d-" + uuid.uuid4().hex[:8],
            "name": name,
            "hints": hints[:6],
            "sample_titles": matched[:3],
            "count": len(matched),
        })
        if len(out) >= MAX_PROPOSALS:
            break
    return out


async def discover(since_days: int = 90, *, timeout: float = 60.0) -> dict:
    """One model call; writes the proposal file (even on failure, so boot does
    not retry forever). A concurrent call returns the current file."""
    if _LOCK.locked():
        return load_proposals()
    async with _LOCK:
        titles = _recent_titles(since_days)
        data = _empty()
        data["created"] = int(time.time() * 1000)
        data["model"] = config.TITLE_MODEL
        if not config.PROJECT_CLASSIFY_ENABLED or not local_llm.can_route(config.TITLE_MODEL):
            data["error"] = "no_local_model"
        elif len(titles) < MIN_SESSIONS:
            data["error"] = "too_few_threads"
        else:
            raw = await local_llm.complete(config.TITLE_MODEL, build_prompt(titles),
                                           max_tokens=800, temperature=0.0, timeout=timeout)
            if raw == "":
                data["error"] = "model_failed"
            else:
                data["proposals"] = parse_proposals(raw, titles)
        save_proposals(data)
        log.info("project discovery: %d proposals (%s)", len(data["proposals"]), data["error"] or "ok")
        return data
