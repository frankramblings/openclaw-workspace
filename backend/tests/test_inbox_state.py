"""Unit tests for the Inbox local triage state store."""
import importlib

from backend.inbox import state


def _fresh(tmp_path, monkeypatch):
    monkeypatch.setattr(state, "STATE_FILE", tmp_path / "inbox-state.json")
    state._mem = None  # drop cache so each test starts clean
    return state


def test_dismiss_hides_forever(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    assert not s.hidden("gmail", "abc", now_ms=1000)
    s.dismiss("gmail", "abc", "archived")
    assert s.hidden("gmail", "abc", now_ms=1000)
    assert s.hidden("gmail", "abc", now_ms=10**15)  # forever


def test_snooze_hides_until_expiry(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.snooze("asana", "t1", until_ms=5000)
    assert s.hidden("asana", "t1", now_ms=4999)
    assert not s.hidden("asana", "t1", now_ms=5001)  # expired -> visible again
    # expiry is sticky: the expired entry was cleaned up
    assert "asana:t1" not in s._load().get("snoozed", {})


def test_state_persists_across_reload(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.dismiss("slack", "m1")
    s._mem = None  # simulate process restart
    assert s.hidden("slack", "m1", now_ms=0)


def test_sources_do_not_collide(tmp_path, monkeypatch):
    s = _fresh(tmp_path, monkeypatch)
    s.dismiss("gmail", "x")
    assert not s.hidden("slack", "x", now_ms=0)
