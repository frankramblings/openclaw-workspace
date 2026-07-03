"""Unit tests for the recommendation layers (pure)."""
from backend.inbox import recommend


def _gmail(addr="ada@example.com", age_h=1.0):
    return {"id": "1", "source": "gmail", "title": "Hi", "ageHours": age_h,
            "meta": {"from": addr}, "actions": ["archive", "delete", "dismiss", "snooze"]}


def _slack(kind="unread", age_h=1.0, channel="#general"):
    return {"id": "m1", "source": "slack", "title": "msg", "ageHours": age_h,
            "snippet": kind, "meta": {"channel": channel, "kind": kind},
            "actions": ["mark_read", "dismiss", "snooze"]}


def test_heuristic_newsletter_sender_archives():
    rec = recommend.heuristic_rec(_gmail("no-reply@asana.com"))
    assert rec == {"action": "archive", "by": "heuristic",
                   "reason": "newsletter/notification sender"}
    assert recommend.heuristic_rec(_gmail("taylor@example.com")) is None


def test_heuristic_stale_slack_unread():
    assert recommend.heuristic_rec(_slack(age_h=200))["action"] == "mark_read"
    assert recommend.heuristic_rec(_slack(age_h=5)) is None
    assert recommend.heuristic_rec(_slack(kind="mention", age_h=200)) is None


def _obs_item(kind, assignee=None):
    return {"id": "o1", "source": "obsidian", "title": "Send the deck",
            "ageHours": 5.0, "snippet": kind,
            "meta": {"kind": kind, "assignee": assignee},
            "actions": ["add_asana", "reviewed", "dismiss", "snooze"]}


def test_heuristic_other_peoples_action_suggests_dismiss():
    # An item assigned to someone other than Frank -> immediate dismiss hint.
    rec = recommend.heuristic_rec(_obs_item("action-other", assignee="Allie"))
    assert rec == {"action": "dismiss", "by": "heuristic",
                   "reason": "assigned to Allie"}
    # Frank's own / team / unassigned items get no such nudge.
    assert recommend.heuristic_rec(_obs_item("action-mine", "Frank")) is None
    assert recommend.heuristic_rec(_obs_item("action")) is None


def test_history_rec_threshold():
    stats = {"gmail:news@x.com": {"delete": 4, "archive": 1}}   # 80% delete
    rec = recommend.history_rec(_gmail("news@x.com"), stats)
    assert rec["action"] == "delete" and rec["by"] == "history"
    assert "4/5" in rec["reason"]
    # below 3 total -> none; below 80% share -> none
    assert recommend.history_rec(_gmail("a@b.c"), {"gmail:a@b.c": {"delete": 2}}) is None
    assert recommend.history_rec(
        _gmail("a@b.c"), {"gmail:a@b.c": {"delete": 3, "archive": 2}}) is None


def test_precedence_ai_over_history_over_heuristic():
    stats = {"gmail:no-reply@asana.com": {"delete": 5}}
    ai = {"gmail:1": {"action": "reply", "confidence": "high",
                      "reason": "asks a question", "ts": 1}}
    item = _gmail("no-reply@asana.com")
    rec = recommend.pick(item, stats, ai)
    assert rec["by"] == "ai" and rec["action"] == "reply"
    rec2 = recommend.pick(item, stats, {})
    assert rec2["by"] == "history"
    rec3 = recommend.pick(item, {}, {})
    assert rec3["by"] == "heuristic"
    assert recommend.pick(_gmail("taylor@example.com"), {}, {}) is None


def test_ai_rec_with_disallowed_action_is_ignored():
    ai = {"slack:m1": {"action": "delete", "confidence": "high",
                       "reason": "x", "ts": 1}}
    assert recommend.pick(_slack(), {}, ai) is None


# --- regression: recs must not outlive their stats on cached items -----------

import pytest
from httpx import ASGITransport, AsyncClient

import backend.inbox as inbox
from backend.inbox import state


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.mark.anyio
async def test_stale_rec_cleared_when_stats_drop(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "state.json")
    monkeypatch.setattr(state, "_mem", None)
    inbox._cache.clear()

    async def fake_gmail():
        return [{**_gmail("news@x.com"), "title": "Mail", "subtitle": "",
                 "snippet": "", "ts": 2, "score": 5}]

    for name in list(inbox.SOURCES):
        monkeypatch.setitem(inbox.SOURCES, name, fake_gmail)

    from backend.app import app
    client = AsyncClient(transport=ASGITransport(app=app), base_url="http://t")
    for _ in range(3):
        state.bump_stat("gmail:news@x.com", "archive")
    async with client as c:
        r1 = (await c.get("/api/items?sources=gmail")).json()
        assert r1["items"][0]["rec"]["by"] == "history"
        # stats drop (e.g. three undos) while the 60s source cache is warm
        for _ in range(3):
            state.drop_stat("gmail:news@x.com", "archive")
        r2 = (await c.get("/api/items?sources=gmail")).json()
    assert "rec" not in r2["items"][0]


def test_obsidian_allows_add_asana():
    assert "add_asana" in recommend.ALLOWED["obsidian"]


def test_parse_keeps_task_and_due_for_obsidian():
    valid = {"o1": "obsidian"}
    reply = ('[{"id":"o1","action":"add_asana","confidence":"high",'
             '"reason":"commitment to Taylor","task":"Send Q3 deck",'
             '"due":"2026-07-03"}]')
    out = recommend.parse_triage_reply(reply, valid, now_ms=0)
    rec = out["obsidian:o1"]
    assert rec["action"] == "add_asana"
    assert rec["task"] == "Send Q3 deck"
    assert rec["due"] == "2026-07-03"


def test_parse_ignores_task_due_for_non_obsidian():
    valid = {"g1": "gmail"}
    reply = '[{"id":"g1","action":"archive","task":"x","due":"2026-01-01"}]'
    rec = recommend.parse_triage_reply(reply, valid, now_ms=0)["gmail:g1"]
    assert "task" not in rec and "due" not in rec


# --- obsidian learning: counter keys + history recs --------------------------

def _obsidian(text="Send the deck", assignee=None, file="2026-06-23 - Brand team bi-weekly.md"):
    return {"id": "o1", "source": "obsidian", "title": text, "ageHours": 5.0,
            "snippet": "action", "meta": {"file": file, "assignee": assignee},
            "actions": ["reviewed", "dismiss", "snooze"]}


def test_counter_key_obsidian_prefers_assignee():
    # An action assigned to someone learns per-person ("is this mine?").
    assert recommend.counter_key(_obsidian(assignee="Allie")) == "obsidian:who:allie"


def test_counter_key_obsidian_falls_back_to_meeting_series():
    # No assignee -> learn per recurring meeting, date prefix stripped.
    assert (recommend.counter_key(_obsidian(assignee=None))
            == "obsidian:mtg:brand team bi-weekly")


def test_counter_key_obsidian_none_when_no_signal():
    assert recommend.counter_key(_obsidian(assignee=None, file="")) is None


def test_obsidian_allows_dismiss_for_learned_noise():
    # "dismiss as noise" must be an executable learned action for obsidian.
    assert "dismiss" in recommend.ALLOWED["obsidian"]


def test_history_rec_learns_obsidian_by_assignee():
    # 4/5 times I dismissed Allie's action items -> recommend dismiss.
    stats = {"obsidian:who:allie": {"dismiss": 4, "add_asana": 1}}
    rec = recommend.history_rec(_obsidian(assignee="Allie"), stats)
    assert rec["action"] == "dismiss" and rec["by"] == "history"
    assert "4/5" in rec["reason"]


def test_history_rec_learns_obsidian_by_meeting():
    stats = {"obsidian:mtg:brand team bi-weekly": {"add_asana": 5}}
    rec = recommend.history_rec(_obsidian(assignee=None), stats)
    assert rec["action"] == "add_asana" and rec["by"] == "history"


def test_entities_allowed_actions():
    from backend.inbox import recommend
    assert "entities" in recommend.ALLOWED
    assert {"confirm", "reclassify", "not_entity", "none"} <= recommend.ALLOWED["entities"]
