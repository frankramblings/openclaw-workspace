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
    assert recommend.heuristic_rec(_gmail("taylor@wistia.com")) is None


def test_heuristic_stale_slack_unread():
    assert recommend.heuristic_rec(_slack(age_h=200))["action"] == "mark_read"
    assert recommend.heuristic_rec(_slack(age_h=5)) is None
    assert recommend.heuristic_rec(_slack(kind="mention", age_h=200)) is None


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
    assert recommend.pick(_gmail("taylor@wistia.com"), {}, {}) is None


def test_ai_rec_with_disallowed_action_is_ignored():
    ai = {"slack:m1": {"action": "delete", "confidence": "high",
                       "reason": "x", "ts": 1}}
    assert recommend.pick(_slack(), {}, ai) is None
