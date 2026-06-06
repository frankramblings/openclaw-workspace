"""Unit tests for Inbox v2.1 state: history log, stat counters, recs cache."""
from backend.inbox import state


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "inbox-state.json")
    monkeypatch.setattr(state, "_mem", None)
    return state


def test_log_action_prepends_and_caps(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    ts1 = s.log_action("gmail", "1", "Mail one", "archive",
                       undo={"folder": "[Gmail]/All Mail", "from": "a@b.c"},
                       stat_key="gmail:a@b.c")
    ts2 = s.log_action("gmail", "2", "Mail two", "delete", undo=None,
                       stat_key=None)
    hist = s.history()
    assert [e["id"] for e in hist] == ["2", "1"]      # newest first
    assert ts2 != ts1                                  # ts is the unique undo key
    assert hist[1]["undo"]["folder"] == "[Gmail]/All Mail"
    assert hist[0]["undo"] is None
    for i in range(150):                               # cap at 100
        s.log_action("slack", str(i), "t", "mark_read", undo=None, stat_key=None)
    assert len(s.history(limit=200)) == 100


def test_pop_history_removes_and_returns(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    ts = s.log_action("asana", "g1", "Task", "complete",
                      undo={"asana_gid": "g1"}, stat_key=None)
    entry = s.pop_history(ts)
    assert entry["action"] == "complete"
    assert s.pop_history(ts) is None                   # gone
    assert s.history() == []


def test_stats_bump_and_drop(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    for _ in range(3):
        s.bump_stat("gmail:news@x.com", "archive")
    s.bump_stat("gmail:news@x.com", "delete")
    assert s.stats()["gmail:news@x.com"] == {"archive": 3, "delete": 1}
    s.drop_stat("gmail:news@x.com", "delete")
    assert s.stats()["gmail:news@x.com"] == {"archive": 3}   # zero entries pruned
    s.drop_stat("gmail:nobody@x.com", "archive")             # no-op, no crash


def test_undismiss_restores_card(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.dismiss("gmail", "9", "archived")
    s.snooze("gmail", "9", until_ms=10**15)
    assert s.hidden("gmail", "9", now_ms=0)
    s.undismiss("gmail", "9")
    assert not s.hidden("gmail", "9", now_ms=0)


def test_recs_cache_set_get_prune(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    old = {"action": "archive", "confidence": "high", "reason": "old", "ts": 1}
    new = {"action": "gary", "confidence": "med", "reason": "new", "ts": 10**15}
    s.set_recs({"gmail:1": old, "gmail:2": new}, live_keys={"gmail:2"},
               now_ms=10**15)
    # gmail:1 is >7d old AND absent from the live feed -> pruned
    assert set(s.recs()) == {"gmail:2"}
    # an old rec still present in the feed survives
    s.set_recs({"gmail:3": dict(old)}, live_keys={"gmail:3"}, now_ms=10**15)
    assert "gmail:3" in s.recs()
