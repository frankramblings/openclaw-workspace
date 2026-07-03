"""Inbox source: cortex entity verifications.

Surfaces unverified names from the Digital Cortex `People_Pending.md`, guesses a
type (person / org / event / project / other) so Frank confirms rather than
classifies from scratch, and excludes anything already decided. Decisions are
written back by the action router via `entities_store` — see backend/inbox/entities_store.py.
"""
from __future__ import annotations

import re

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
