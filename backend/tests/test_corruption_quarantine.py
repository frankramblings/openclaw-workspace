"""Corruption quarantine: a malformed on-disk JSON store must not be
silently replaced by an empty default.

The bug class this kills: sessions_store._load() (and its siblings) used to
catch JSONDecodeError, return an empty default, and let the caller's next
_save() overwrite the file with that rebuilt-empty store — silent total loss
of the user's data. fsutil.load_json_guarded renames the corrupt file aside
instead, so the original bytes always survive on disk for recovery.

Covers the fsutil helper directly, then each of its four real callers
(sessions_store, inbox.state, terminals.read_meta, config.load_branding /
load_connection) to prove they're actually routed through it rather than
independently reimplementing the same idea."""
from __future__ import annotations

import json
import logging
import os
import re

import pytest

from backend import config, fsutil, sessions_store, terminals
from backend.inbox import state as inbox_state

CORRUPT_RE = re.compile(r"\.corrupt-\d{8}-\d{6}(-\d+)?$")


class _RecordingLogger:
    """Minimal logger stand-in: records .error() calls so tests can assert
    on them without depending on caplog's handler/propagation wiring."""

    def __init__(self):
        self.errors: list[tuple] = []

    def error(self, msg, *args):
        self.errors.append((msg, args))


# --- fsutil.load_json_guarded: the core contract -----------------------------

def test_missing_file_returns_default_no_rename_no_log(tmp_path):
    log = _RecordingLogger()
    p = tmp_path / "store.json"
    result = fsutil.load_json_guarded(p, {"x": []}, logger=log)
    assert result == {"x": []}
    assert list(tmp_path.iterdir()) == []  # nothing created
    assert log.errors == []


def test_valid_json_loads_normally_no_quarantine(tmp_path):
    log = _RecordingLogger()
    p = tmp_path / "store.json"
    p.write_text(json.dumps({"sessions": [{"id": "a"}]}))
    result = fsutil.load_json_guarded(p, {"sessions": []}, logger=log)
    assert result == {"sessions": [{"id": "a"}]}
    assert p.exists()
    assert p.read_text() == json.dumps({"sessions": [{"id": "a"}]})
    assert log.errors == []


def test_garbage_json_quarantines_preserves_bytes_and_returns_default(tmp_path):
    log = _RecordingLogger()
    p = tmp_path / "store.json"
    garbage = b'{"sessions": [ this is not valid json'
    p.write_bytes(garbage)

    result = fsutil.load_json_guarded(p, {"sessions": []}, logger=log)

    assert result == {"sessions": []}
    assert not p.exists()  # original name freed by the rename
    quarantined = list(tmp_path.iterdir())
    assert len(quarantined) == 1
    assert CORRUPT_RE.search(quarantined[0].name), quarantined[0].name
    assert quarantined[0].name.startswith("store.json.corrupt-")
    assert quarantined[0].read_bytes() == garbage  # bytes survive untouched

    assert len(log.errors) == 1
    msg, args = log.errors[0]
    assert msg == "quarantined corrupt store %s -> %s"
    assert args == (p, quarantined[0])


def test_invalid_utf8_quarantines_same_as_bad_json(tmp_path):
    log = _RecordingLogger()
    p = tmp_path / "store.json"
    bad_utf8 = b"\xff\xfe\x00\x01 not valid utf-8"
    p.write_bytes(bad_utf8)

    result = fsutil.load_json_guarded(p, [], logger=log)

    assert result == []
    quarantined = list(tmp_path.iterdir())
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == bad_utf8
    assert len(log.errors) == 1


def test_collision_safe_numeric_suffix_for_same_second_quarantines(tmp_path, monkeypatch):
    monkeypatch.setattr(fsutil.time, "strftime", lambda *_: "20260101-000000")
    log = _RecordingLogger()
    p = tmp_path / "store.json"

    p.write_bytes(b"not json 1")
    fsutil.load_json_guarded(p, {}, logger=log)

    p.write_bytes(b"not json 2")  # store re-created and corrupted again
    fsutil.load_json_guarded(p, {}, logger=log)

    names = sorted(f.name for f in tmp_path.iterdir())
    assert names == [
        "store.json.corrupt-20260101-000000",
        "store.json.corrupt-20260101-000000-1",
    ]
    assert (tmp_path / "store.json.corrupt-20260101-000000").read_bytes() == b"not json 1"
    assert (tmp_path / "store.json.corrupt-20260101-000000-1").read_bytes() == b"not json 2"
    assert len(log.errors) == 2


def test_file_vanishing_before_rename_does_not_crash(tmp_path, monkeypatch):
    """Races with another process: by the time we try to quarantine, the file
    we just read as corrupt is already gone. Must not raise."""
    log = _RecordingLogger()
    p = tmp_path / "store.json"
    p.write_bytes(b"not json")

    def _raced_away(*a, **kw):
        raise FileNotFoundError("gone")

    monkeypatch.setattr(fsutil.os, "replace", _raced_away)

    result = fsutil.load_json_guarded(p, {"ok": True}, logger=log)

    assert result == {"ok": True}
    assert log.errors == []  # nothing was actually quarantined, nothing to log


# --- sessions_store._load(): the sentinel bug this task exists to kill -------
# (_isolated_data_dir in conftest.py already points _STORE_FILE at tmp_path)

def test_sessions_store_quarantines_corrupt_file_and_save_does_not_touch_it():
    store_file = sessions_store._STORE_FILE
    store_file.parent.mkdir(parents=True, exist_ok=True)
    garbage = b'{"sessions": [ broken'
    store_file.write_bytes(garbage)

    assert sessions_store.list_sessions() == []  # default, not a crash

    quarantined = [f for f in store_file.parent.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == garbage

    rec = sessions_store.create(name="after quarantine")
    assert [s["id"] for s in sessions_store.list_sessions()] == [rec["id"]]
    # the quarantined bytes must survive the subsequent save untouched
    assert quarantined[0].read_bytes() == garbage
    assert quarantined[0].exists()


def test_sessions_store_missing_file_returns_default_no_quarantine():
    store_file = sessions_store._STORE_FILE
    assert not store_file.exists()
    assert sessions_store.list_sessions() == []
    leftover = list(store_file.parent.iterdir()) if store_file.parent.exists() else []
    assert leftover == []


def test_sessions_store_quarantine_emits_error_log_record(caplog):
    """Task 13 (Step 4): the quarantine must emit a real ERROR record through
    the stdlib logging pipeline. The _RecordingLogger tests above prove the
    .error() call happens; this proves it lands at ERROR level on the actual
    production logger (`backend.sessions_store`, the module logger
    sessions_store passes to load_json_guarded) with both paths — the corrupt
    original and its quarantine destination — in the record args."""
    store_file = sessions_store._STORE_FILE
    store_file.parent.mkdir(parents=True, exist_ok=True)
    store_file.write_bytes(b'{"sessions": [ broken')

    with caplog.at_level(logging.ERROR, logger="backend.sessions_store"):
        assert sessions_store.list_sessions() == []  # triggers the quarantine

    recs = [r for r in caplog.records
            if r.name == "backend.sessions_store" and r.levelno == logging.ERROR
            and "quarantined corrupt store" in r.getMessage()]
    assert len(recs) == 1
    src, dest = recs[0].args
    assert src == store_file
    assert str(dest).startswith(str(store_file) + ".corrupt-")
    assert CORRUPT_RE.search(str(dest))
    # And the formatted message names both paths (what actually hits the log).
    assert str(store_file) in recs[0].getMessage()
    assert str(dest) in recs[0].getMessage()


# --- inbox.state: same store-file pattern, different shape ------------------

def _fresh_inbox_state(tmp_path, monkeypatch):
    monkeypatch.setattr(inbox_state, "STATE_FILE", tmp_path / "inbox-state.json")
    monkeypatch.setattr(inbox_state, "_mem", None)
    return inbox_state


def test_inbox_state_quarantines_corrupt_file(tmp_path, monkeypatch):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    garbage = b"{not valid inbox state"
    s.STATE_FILE.write_bytes(garbage)

    assert s.hidden("gmail", "x", now_ms=0) is False  # rebuilt-default, no crash

    quarantined = [f for f in tmp_path.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == garbage

    s.dismiss("gmail", "x")  # triggers a save
    assert quarantined[0].read_bytes() == garbage  # untouched by the save


def test_inbox_state_missing_file_returns_default_no_quarantine(tmp_path, monkeypatch):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    assert not s.hidden("gmail", "x", now_ms=0)
    assert list(tmp_path.iterdir()) == []


# --- terminals.read_meta: persisted terminal index ---------------------------
# (_isolated_data_dir in conftest.py points config.DATA_DIR at tmp_path/"data",
# and terminals resolves persist paths from config.DATA_DIR at call time)

def test_terminals_read_meta_quarantines_corrupt_file():
    key = "quarantine-key"
    meta_path = terminals.persist_meta_path(key)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    garbage = b"{not valid meta"
    meta_path.write_bytes(garbage)

    assert terminals.read_meta(key) == {}  # default, not a crash

    quarantined = [f for f in meta_path.parent.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == garbage

    terminals.write_meta(key, persist=True)  # triggers a save
    assert quarantined[0].read_bytes() == garbage  # untouched by the save


def test_terminals_read_meta_missing_file_returns_default_no_quarantine():
    key = "never-seen-key"
    meta_path = terminals.persist_meta_path(key)
    assert not meta_path.exists()
    assert terminals.read_meta(key) == {}
    assert not meta_path.parent.exists()


@pytest.mark.skipif(os.geteuid() == 0, reason="chmod 000 does not block root")
def test_terminals_read_meta_degrades_to_default_on_unreadable_file(caplog):
    """A meta.json that exists but can't be read (PermissionError et al.) must
    degrade to the default shape, not raise: read_meta's callers (the terminal
    WS stream, the MCP run/write routes, the persist routes) call it bare, so
    an exception here 500s routes and tears down the WS. Unreadable is NOT
    corruption — the file must stay put, no quarantine."""
    key = "unreadable-key"
    meta_path = terminals.persist_meta_path(key)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text('{"persist": true}')
    os.chmod(meta_path, 0o000)
    try:
        with caplog.at_level(logging.WARNING, logger="backend.terminals"):
            assert terminals.read_meta(key) == {}  # degrade, don't raise
        assert meta_path.exists()  # not quarantined — it isn't corrupt
        quarantined = [f for f in meta_path.parent.iterdir() if CORRUPT_RE.search(f.name)]
        assert quarantined == []
        assert any("terminal meta unreadable" in r.getMessage() for r in caplog.records)
    finally:
        os.chmod(meta_path, 0o600)  # so pytest's tmp cleanup can proceed


# --- config.py: the two .data/*.json readers (branding, connection) ---------

def test_load_branding_quarantines_corrupt_file(tmp_path, monkeypatch):
    path = tmp_path / "branding.json"
    monkeypatch.setattr(config, "BRANDING_PATH", path)
    garbage = b"{not valid branding"
    path.write_bytes(garbage)

    assert config.load_branding() == {}  # default, not a crash

    quarantined = [f for f in tmp_path.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == garbage


def test_load_branding_missing_file_returns_default_no_quarantine(tmp_path, monkeypatch):
    path = tmp_path / "branding.json"
    monkeypatch.setattr(config, "BRANDING_PATH", path)
    assert config.load_branding() == {}
    assert list(tmp_path.iterdir()) == []


def test_save_branding_after_quarantine_does_not_touch_quarantined(tmp_path, monkeypatch):
    path = tmp_path / "branding.json"
    monkeypatch.setattr(config, "BRANDING_PATH", path)
    garbage = b"{not valid branding"
    path.write_bytes(garbage)

    assert config.load_branding() == {}
    quarantined = [f for f in tmp_path.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1

    config.save_branding(agent_name="Gary")  # save lands on the freed name...
    assert quarantined[0].read_bytes() == garbage  # ...never on the quarantine
    assert config.load_branding() == {"agent_name": "Gary"}


def test_load_connection_quarantines_corrupt_file(tmp_path, monkeypatch):
    path = tmp_path / "connection.json"
    monkeypatch.setattr(config, "CONNECTION_PATH", path)
    garbage = b"{not valid connection"
    path.write_bytes(garbage)

    assert config.load_connection() == {}  # default, not a crash

    quarantined = [f for f in tmp_path.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1
    assert quarantined[0].read_bytes() == garbage


def test_load_connection_missing_file_returns_default_no_quarantine(tmp_path, monkeypatch):
    path = tmp_path / "connection.json"
    monkeypatch.setattr(config, "CONNECTION_PATH", path)
    assert config.load_connection() == {}
    assert list(tmp_path.iterdir()) == []


def test_save_connection_after_quarantine_does_not_touch_quarantined(tmp_path, monkeypatch):
    path = tmp_path / "connection.json"
    monkeypatch.setattr(config, "CONNECTION_PATH", path)
    garbage = b"{not valid connection"
    path.write_bytes(garbage)

    assert config.load_connection() == {}
    quarantined = [f for f in tmp_path.iterdir() if CORRUPT_RE.search(f.name)]
    assert len(quarantined) == 1

    config.save_connection(gateway_ws="ws://box:9999")
    assert quarantined[0].read_bytes() == garbage  # untouched by the save
    assert config.load_connection() == {"gateway_ws": "ws://box:9999"}
