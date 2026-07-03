"""Inbox source: cortex entity verifications.

Surfaces unverified names from the Digital Cortex `People_Pending.md`, guesses a
type (person / org / event / project / other) so Frank confirms rather than
classifies from scratch, and excludes anything already decided. Decisions are
written back by the action router via `entities_store` — see backend/inbox/entities_store.py.
"""
from __future__ import annotations

import re
import time

from .. import entities_store, settings

# Keyword precedence: event/other first, then project, then org; person only if
# it looks like an actual "First Last" name. Ambiguous → other (never person).
_EVENT = re.compile(
    r"\b(Meeting|Sync|Report|Update|Review|Party|Week|Session|Touchbase|Block|"
    r"Promo|Recap|Standup|Offsite|Lunch|Mass)\b", re.I)
_PROJECT = re.compile(
    r"\b(Suite|Kit|Program|Framework|Template|Campaign|Initiative|Launch|"
    r"Rollout|Plan)\b", re.I)
_ORG = re.compile(
    r"\b(Team|Inc|LLC|Corp|Group|Co|Labs|Partners|Agency|Networks|Cloud)\b", re.I)

# Small common-given-name set: a strong positive signal for "person".
_GIVEN_NAMES = {
    "allie", "ash", "aubry", "chris", "elise", "frank", "jayde", "laura",
    "marissa", "shaunna", "sylvie", "taylor", "tim", "kelly", "andrew",
    "natasha", "kathleen",
}


def guess_type(name: str) -> str:
    n = (name or "").strip()
    if not n:
        return "other"
    if _EVENT.search(n):
        return "event"
    if _PROJECT.search(n):
        return "project"
    if _ORG.search(n):
        return "org"
    tokens = n.split()
    if len(tokens) == 2 and all(t[:1].isupper() for t in tokens):
        if tokens[0].lower() in _GIVEN_NAMES:
            return "person"
        # Two TitleCase tokens with no other signal: treat as a name.
        return "person"
    return "other"


_BLOCK = re.compile(r"^##\s+(.+?)\n```yaml\n(.*?)\n```", re.MULTILINE | re.DOTALL)


def _field(block: str, key: str) -> str:
    m = re.search(rf"^{key}:\s*\"?(.*?)\"?\s*$", block, re.MULTILINE)
    return m.group(1).strip() if m else ""


def map_items(pending_md: str, overrides: dict, denylist: set,
              now_ms: int) -> list[dict]:
    items: list[dict] = []
    for heading, block in _BLOCK.findall(pending_md or ""):
        name = (_field(block, "name") or heading).strip()
        canon = entities_store.canon_name(name)
        ov = overrides.get(canon)
        if (ov and ov.get("verified")) or canon in denylist:
            continue  # decided already — never resurface
        first_seen = _field(block, "first_seen_in")
        refs = re.findall(r"-\s+\"([^\"]+)\"", block)
        guess = guess_type(name)
        items.append({
            "id": canon,
            "source": "entities",
            "title": name,
            "subtitle": f"guessed: {guess}",
            "snippet": first_seen,
            "ts": now_ms,
            "ageHours": 0.0,
            "score": 40,
            "meta": {"canon": canon, "guessType": guess, "name": name,
                     "evidence": refs, "file": first_seen},
            "actions": ["confirm", "reclassify", "not_entity",
                        "open", "gary", "snooze", "dismiss"],
        })
    items.sort(key=lambda i: i["title"].lower())
    return items


async def fetch() -> list[dict]:
    path = settings.entities_dir() / "People_Pending.md"
    try:
        pending_md = path.read_text(encoding="utf-8")
    except Exception:
        return []
    overrides = entities_store.load_overrides()
    denylist = entities_store.load_denylist()
    return map_items(pending_md, overrides, denylist,
                     now_ms=int(time.time() * 1000))
