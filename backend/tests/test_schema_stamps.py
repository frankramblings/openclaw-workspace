"""Task 15: schema-version stamps on sessions_store and inbox.state.

Both stores now write "schema_version": SCHEMA_VERSION on every save. Loaders
must accept a file with no schema_version at all (legacy, pre-Task-15 data --
treated as fine, no warning) and log.warning when a loaded file's version is
HIGHER than the version this code knows about (a downgrade: an older app
build reading data a newer build wrote). Neither case may break the existing
round-trip behavior."""
from __future__ import annotations

import json
import logging

from backend import sessions_store
from backend.inbox import state as inbox_state

# --- sessions_store ------------------------------------------------------------
# (conftest.py's autouse _isolated_data_dir fixture already points
# sessions_store._STORE_FILE at a tmp path per test.)


def test_sessions_store_save_stamps_schema_version():
    sessions_store.create(name="stamped")
    on_disk = json.loads(sessions_store._STORE_FILE.read_text())
    assert on_disk["schema_version"] == sessions_store.SCHEMA_VERSION


def test_sessions_store_round_trips_normally_after_stamping():
    rec = sessions_store.create(name="round trip")
    sessions_store.update(rec["id"], name="renamed")
    assert sessions_store.get(rec["id"])["name"] == "renamed"
    assert [s["id"] for s in sessions_store.list_sessions()] == [rec["id"]]


def test_sessions_store_loads_legacy_file_with_no_schema_version():
    sessions_store._STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
    legacy = {"sessions": [{"id": "abc123", "name": "Legacy chat", "created": 1}]}
    sessions_store._STORE_FILE.write_text(json.dumps(legacy))  # no schema_version key

    sessions = sessions_store.list_sessions()

    assert [s["id"] for s in sessions] == ["abc123"]
    # the next save re-stamps the file going forward
    sessions_store.update("abc123", name="touched")
    on_disk = json.loads(sessions_store._STORE_FILE.read_text())
    assert on_disk["schema_version"] == sessions_store.SCHEMA_VERSION


def test_sessions_store_legacy_file_load_does_not_warn(caplog):
    sessions_store._STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
    sessions_store._STORE_FILE.write_text(json.dumps({"sessions": []}))
    with caplog.at_level(logging.WARNING, logger="backend.sessions_store"):
        sessions_store.list_sessions()
    assert not any("schema_version" in r.getMessage() for r in caplog.records)


def test_sessions_store_higher_schema_version_logs_warning(caplog):
    sessions_store._STORE_FILE.parent.mkdir(parents=True, exist_ok=True)
    future = {"sessions": [{"id": "x", "name": "From the future", "created": 1}],
              "schema_version": sessions_store.SCHEMA_VERSION + 1}
    sessions_store._STORE_FILE.write_text(json.dumps(future))

    with caplog.at_level(logging.WARNING, logger="backend.sessions_store"):
        sessions = sessions_store.list_sessions()

    assert [s["id"] for s in sessions] == ["x"]  # still loads, best-effort
    assert any(
        "schema_version" in r.getMessage() and str(sessions_store.SCHEMA_VERSION + 1) in r.getMessage()
        for r in caplog.records
    )


# --- inbox.state ----------------------------------------------------------------

def _fresh_inbox_state(tmp_path, monkeypatch):
    monkeypatch.setattr(inbox_state, "STATE_FILE", tmp_path / "inbox-state.json")
    monkeypatch.setattr(inbox_state, "_mem", None)
    return inbox_state


def test_inbox_state_save_stamps_schema_version(tmp_path, monkeypatch):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    s.dismiss("gmail", "abc")
    on_disk = json.loads(s.STATE_FILE.read_text())
    assert on_disk["schema_version"] == s.SCHEMA_VERSION


def test_inbox_state_round_trips_normally_after_stamping(tmp_path, monkeypatch):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    s.dismiss("gmail", "abc")
    s._mem = None  # simulate process restart -> reload from disk
    assert s.hidden("gmail", "abc", now_ms=0)


def test_inbox_state_loads_legacy_file_with_no_schema_version(tmp_path, monkeypatch):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    legacy = {"dismissed": {"gmail:abc": {"reason": "dismissed", "ts": 1}}}
    s.STATE_FILE.write_text(json.dumps(legacy))  # no schema_version key

    assert s.hidden("gmail", "abc", now_ms=0)

    # the next save re-stamps the file going forward
    s.dismiss("slack", "z")
    on_disk = json.loads(s.STATE_FILE.read_text())
    assert on_disk["schema_version"] == s.SCHEMA_VERSION


def test_inbox_state_legacy_file_load_does_not_warn(tmp_path, monkeypatch, caplog):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    s.STATE_FILE.write_text(json.dumps({}))
    with caplog.at_level(logging.WARNING, logger="backend.inbox.state"):
        s.hidden("gmail", "x", now_ms=0)
    assert not any("schema_version" in r.getMessage() for r in caplog.records)


def test_inbox_state_higher_schema_version_logs_warning(tmp_path, monkeypatch, caplog):
    s = _fresh_inbox_state(tmp_path, monkeypatch)
    future = {"dismissed": {"gmail:abc": {"reason": "dismissed", "ts": 1}},
              "schema_version": s.SCHEMA_VERSION + 1}
    s.STATE_FILE.write_text(json.dumps(future))

    with caplog.at_level(logging.WARNING, logger="backend.inbox.state"):
        result = s.hidden("gmail", "abc", now_ms=0)

    assert result is True  # still loads, best-effort
    assert any(
        "schema_version" in r.getMessage() and str(s.SCHEMA_VERSION + 1) in r.getMessage()
        for r in caplog.records
    )
