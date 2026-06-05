"""Asana tasks (my project board) via the REST API + PAT.

Port of triage-dashboard api/asana.js. The PAT lives in
~/.openclaw/workspace/secrets/asana.env (ASANA_PAT=...); GIDs identify the
user's workspace/board and are stable — env-overridable for safety."""
from __future__ import annotations

import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

from ... import config

ENV_PATH = Path(os.environ.get(
    "INBOX_ASANA_ENV", str(config.OPENCLAW_HOME / "workspace/secrets/asana.env")))
PROJECT_GID = os.environ.get("ASANA_PROJECT_GID", "1206273954893328")
ACTIVE_SECTIONS = {"Backlog", "In Progress", "Review"}
BASE = "https://app.asana.com/api/1.0"
_FIELDS = ("name,memberships.section.name,memberships.section.gid,due_on,"
           "due_at,modified_at,created_at,permalink_url,notes,completed")

_token: str | None = None


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc) \
        .isoformat().replace("+00:00", "Z")


def _ms(iso: str | None) -> int | None:
    if not iso:
        return None
    try:
        return int(datetime.fromisoformat(iso.replace("Z", "+00:00"))
                   .timestamp() * 1000)
    except ValueError:
        return None


def _pat() -> str:
    global _token
    if _token:
        return _token
    m = re.search(r'ASANA_PAT="?([^"\n]+)"?', ENV_PATH.read_text())
    if not m:
        raise RuntimeError("ASANA_PAT not found in asana.env")
    _token = m.group(1).strip()
    return _token


async def _api(method: str, path: str, body: dict | None = None) -> dict:
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.request(
            method, f"{BASE}{path}", json=body,
            headers={"Authorization": f"Bearer {_pat()}",
                     "Accept": "application/json"})
    data = r.json()
    if r.status_code >= 400:
        raise RuntimeError(f"asana {r.status_code}: {data.get('errors') or data}")
    return data


def map_items(tasks: list[dict], now_ms: int) -> list[dict]:
    items = []
    for t in tasks:
        if t.get("completed"):
            continue
        membership = next((m for m in t.get("memberships") or []
                           if m.get("section")), None)
        section = (membership or {}).get("section", {}).get("name") or "Asana"
        if section not in ACTIVE_SECTIONS:
            continue
        due = _ms(t.get("due_at")) or (
            _ms(t["due_on"] + "T17:00:00Z") if t.get("due_on") else None)
        ts = _ms(t.get("modified_at")) or now_ms
        age_h = max(0.0, (now_ms - ts) / 3600_000)
        score = {"In Progress": 4, "Review": 3}.get(section, 2)
        if due is not None:
            days = (due - now_ms) / (24 * 3600_000)
            if days < 0:
                score += 4
            elif days < 1:
                score += 3
            elif days < 3:
                score += 2
            elif days < 7:
                score += 1
        items.append({
            "id": t["gid"], "source": "asana",
            "title": t.get("name") or "(no name)",
            "subtitle": section,
            "snippet": (f"due {datetime.fromtimestamp(due / 1000, tz=timezone.utc).date()}"
                        if due else (t.get("notes") or "")[:120]),
            "ts": ts, "ageHours": age_h, "score": score,
            "meta": {"url": t.get("permalink_url"), "due": due,
                     "section": section},
            "actions": ["complete", "dismiss", "snooze"],
        })
    items.sort(key=lambda i: (-i["score"], i["ageHours"]))
    return items


async def fetch() -> list[dict]:
    data = await _api("GET", f"/projects/{PROJECT_GID}/tasks"
                             f"?completed_since=now&limit=100&opt_fields={_FIELDS}")
    return map_items(data.get("data") or [], now_ms=int(time.time() * 1000))


async def complete(gid: str) -> None:
    await _api("PUT", f"/tasks/{gid}", {"data": {"completed": True}})
