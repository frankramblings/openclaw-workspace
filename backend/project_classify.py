"""Auto-filer for projects (spec §6).

At title time a second, tiny local-model call picks exactly one existing
project id or `none` for the new thread. Precision over recall: a wrong
project costs a one-tap correction, a missed one costs nothing. Everything
here is best-effort and never raises into the turn that triggered it."""
from __future__ import annotations

import asyncio
import logging
import re
import time

from . import config, local_llm, projects_store, sessions_store

log = logging.getLogger(__name__)

# Final seed list (Frank, 2026-09-01). Hints are lowercase example keywords
# the prompt shows next to each project. Wedding seeds archived so its
# threads leave RECENT without a live project.
SEEDS: list[dict] = [
    {"name": "Creator & partner program", "archived": False,
     "hints": ["creator program", "influencer", "partnership", "partner", "collab", "amanda", "heike", "taylor deliverable", "briefs", "broadcast partner"]},
    {"name": "UNBOUND", "archived": False,
     "hints": ["unbound", "comms planning", "social first activation"]},
    {"name": "Social strategy", "archived": False,
     "hints": ["hootsuite", "linkedin", "youtube", "organic social", "engaged views", "okr", "audience", "brand forum", "social strategy"]},
    {"name": "Team & 1:1s", "archived": False,
     "hints": ["1:1", "1on1", "meeting notes", "agenda", "team changes", "feedback", "support team", "meeting recap"]},
    {"name": "Wistia tooling", "archived": False,
     "hints": ["wistia mcp", "smart crop", "multicam", "lipsync", "talking head", "webinars mcp", "granola", "obsidian sync", "github pipeline", "agenda automation"]},
    {"name": "Local AI", "archived": False,
     "hints": ["kamino", "local ai", "mlx", "qwen", "glm", "hermes", "omlx", "whisper server", "cloud vs local"]},
    {"name": "Plex", "archived": False,
     "hints": ["plex", "endor", "radarr", "vnc", "storage", "internet slowdown", "apple tv"]},
    {"name": "Workspace", "archived": False,
     "hints": ["workspace", "pwa", "gateway", "chat data", "cron jobs", "dashboard", "tts", "openclaw"]},
    {"name": "BWG", "archived": False,
     "hints": ["bwg", "digression", "episode", "doomsday", "fireside", "sdcc"]},
    {"name": "Podcast pipeline", "archived": False,
     "hints": ["podcast pipeline", "podcast editing", "side hustle", "monetization", "savage", "fireside migration", "rss"]},
    {"name": "Wedding", "archived": True,
     "hints": ["wedding", "toast", "cake", "marriage", "planner"]},
]

_ID_RE = re.compile(r"p-[0-9a-f]{8}")
_BACKFILL_LOCK = asyncio.Lock()


def seed_if_empty() -> int:
    """Create the seed projects when the store has none. Idempotent."""
    if projects_store.list_projects():
        return 0
    n = 0
    for s in SEEDS:
        try:
            projects_store.create(s["name"], hints=s["hints"], archived=s["archived"])
            n += 1
        except ValueError:
            pass
    return n


def candidates() -> list[dict]:
    return [p for p in projects_store.list_projects() if not p.get("archived")]


def build_prompt(title: str, message: str, projects: list[dict]) -> str:
    lines = []
    for p in projects:
        hints = ", ".join(p.get("hints") or [])
        lines.append(f"{p['id']} · {p['name']}" + (f" · e.g. {hints}" if hints else ""))
    body = (message or "").strip()[:400]
    return (
        "You file chat threads into projects. Projects (id · name · example keywords):\n"
        + "\n".join(lines)
        + "\n\nThread title: " + (title or "").strip()[:120]
        + ("\nFirst message: " + body if body else "")
        + "\n\nAnswer with exactly one project id from the list, or the word none. "
        "Answer none unless the thread clearly belongs to one project. Output only the id or none."
    )


def parse_choice(raw: str, valid_ids: set[str]) -> str | None:
    text = (raw or "").strip().lower()
    if not text:
        return None
    found = _ID_RE.findall(text)
    if len(found) != 1:
        return None
    return found[0] if found[0] in valid_ids else None


async def _classify_raw(title: str, message: str, projects: list[dict], *,
                        timeout: float = 30.0) -> tuple[str, bool]:
    """One raw local-model call for filing. Returns (raw, ok) where `ok` is
    False only when the call itself failed -- local_llm.complete never
    raises, it returns "" on any transport/model error, and a real answer is
    always at least the word 'none', so an empty raw response can only mean
    the call failed, never that the model picked 'none'."""
    prompt = build_prompt(title, message, projects)
    raw = await local_llm.complete(config.TITLE_MODEL, prompt, max_tokens=16,
                                   temperature=0.0, timeout=timeout)
    return raw, raw != ""


async def _classify_with_status(title: str, message: str, *,
                                timeout: float = 30.0) -> tuple[str | None, bool]:
    """Same gating as classify() but also reports whether the local-model
    call itself failed (see _classify_raw). `ok` is True when nothing was
    called at all (disabled, no candidates, no local route) -- there is
    nothing to report as a failure in that case. Used by backfill to count
    consecutive model failures distinctly from legitimate 'none' picks."""
    if not config.PROJECT_CLASSIFY_ENABLED:
        return None, True
    projects = candidates()
    if not projects:
        return None, True
    if not local_llm.can_route(config.TITLE_MODEL):
        return None, True
    raw, ok = await _classify_raw(title, message, projects, timeout=timeout)
    pid = parse_choice(raw, {p["id"] for p in projects}) if ok else None
    return pid, ok


async def classify(title: str, message: str) -> str | None:
    pid, _ok = await _classify_with_status(title, message)
    return pid


async def file_session(session_id: str, message: str = "") -> str | None:
    """Classify an unfiled session by its current title (+ optional first
    message) and write `folder`. Returns the project id or None. Never raises."""
    try:
        rec = sessions_store.get(session_id)
        if not rec or rec.get("folder") or rec.get("archived"):
            return None
        pid = await classify(rec.get("name") or "", message)
        if not pid:
            return None
        # spec 4.2 amendment: filing is bookkeeping, not activity -- must not
        # bump `updated` (that would reverse row order inside a project and
        # trigger re-embedding for every session a backfill touches).
        sessions_store.update(session_id, folder=pid, touch=False)
        return pid
    except Exception:  # noqa: BLE001 - best-effort by contract (spec 6.1)
        log.debug("project classify failed for session %s", session_id, exc_info=True)
        return None


def backfill_running() -> bool:
    return _BACKFILL_LOCK.locked()


# I5: a shorter timeout than the title-time hook's default (local_llm.complete's
# 30s) -- backfill can be walking hundreds of sessions one call at a time and
# a dead/slow local endpoint should fail fast instead of stalling the whole run.
_BACKFILL_TIMEOUT = 15.0
# Consecutive local-model failures (empty raw response, never an exception)
# after which a run gives up rather than plowing through every remaining
# candidate one dead call at a time.
_BACKFILL_MAX_CONSECUTIVE_FAILURES = 3


async def backfill(since_days: int = 90) -> dict:
    """File every unfiled, non-archived session updated in the window, by
    title only, one local call at a time. Seeds the project list first when
    it is empty. Idempotent; a second concurrent call is refused. Aborts
    early if the local model looks down (see _BACKFILL_MAX_CONSECUTIVE_FAILURES)
    rather than scanning the rest of the window against a dead endpoint."""
    if _BACKFILL_LOCK.locked():
        return {"scanned": 0, "filed": 0, "skipped": "running"}
    async with _BACKFILL_LOCK:
        seed_if_empty()
        cutoff = int(time.time() * 1000) - int(since_days) * 86400 * 1000
        todo = [s for s in sessions_store.list_sessions()
                if not s.get("archived") and not s.get("folder")
                and (s.get("updated") or s.get("created") or 0) >= cutoff]
        filed = 0
        consecutive_failures = 0
        for i, s in enumerate(todo, 1):
            pid, ok = await _classify_with_status(s.get("name") or "", "",
                                                   timeout=_BACKFILL_TIMEOUT)
            if ok:
                consecutive_failures = 0
                if pid:
                    # touch=False: filing is bookkeeping, not activity (spec
                    # 4.2 amendment) -- see file_session's identical comment.
                    sessions_store.update(s["id"], folder=pid, touch=False)
                    filed += 1
            else:
                consecutive_failures += 1
                if consecutive_failures == 1:
                    log.warning("project backfill: local model call failed for session %s", s["id"])
                if consecutive_failures >= _BACKFILL_MAX_CONSECUTIVE_FAILURES:
                    log.warning(
                        "project backfill aborted after %d consecutive local-model "
                        "failures; %d scanned, %d filed",
                        _BACKFILL_MAX_CONSECUTIVE_FAILURES, i, filed)
                    return {"scanned": i, "filed": filed, "aborted": "model_failures"}
            if i % 25 == 0:
                log.info("project backfill: %d/%d scanned, %d filed", i, len(todo), filed)
        log.info("project backfill done: %d scanned, %d filed", len(todo), filed)
        return {"scanned": len(todo), "filed": filed}
