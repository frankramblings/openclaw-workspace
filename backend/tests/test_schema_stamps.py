"""Task 15/7: schema-version stamps on the mutable JSON stores: sessions_store,
inbox.state, followup, and terminals' per-session meta.json.

Every store here writes "schema_version": SCHEMA_VERSION on every save.
Loaders must accept a file with no schema_version at all (legacy, pre-stamp
data -- treated as fine, no warning) and log.warning when a loaded file's
version is HIGHER than the version this code knows about (a downgrade: an
older app build reading data a newer build wrote). Neither case may break the
existing round-trip behavior.

terminals' OTHER JSON store -- the per-session attachment registry written by
_load_attachments/_save_attachments -- is deliberately NOT stamped here: it's
a flat {token: record} map with no envelope, so a top-level "schema_version"
key would be indistinguishable from an attachment token and would corrupt
list_attachments()'s `for token, e in reg.items(): e.get("pending")` (e would
be the int 1, not a dict). Stamping it would require restructuring to an
enveloped shape, which is out of scope for a same-pattern replication."""
from __future__ import annotations

import json
import logging

from backend import followup, sessions_store, terminals
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


# --- followup ---------------------------------------------------------------
# (conftest.py's autouse _isolated_data_dir fixture points config.DATA_DIR at
# a tmp path per test; followup._store_file() resolves it at call time.)


def _legacy_promise(pid: str) -> dict:
    return {"id": pid, "session_id": "s", "session_key": "k", "label": "t",
            "state": "pending", "created": 1, "deadline_ms": 0, "pinged": 0,
            "exit_code": None, "duration_s": None, "tail": "", "fired": 0,
            "error": ""}


def test_followup_save_stamps_schema_version():
    followup.create_promise("s1", "k1", "task", 60)
    on_disk = json.loads(followup._store_file().read_text())
    assert on_disk["schema_version"] == followup.SCHEMA_VERSION


def test_followup_round_trips_normally_after_stamping():
    p = followup.create_promise("s1", "k1", "task", 60)
    followup.record_completion(p["id"], exit_code=0, duration_s=1, tail="ok")
    got = followup.get_promise(p["id"])
    assert got["exit_code"] == 0
    assert got["state"] == "pending"


def test_followup_loads_legacy_file_with_no_schema_version():
    followup._store_file().parent.mkdir(parents=True, exist_ok=True)
    legacy = {"promises": [_legacy_promise("abc")]}
    followup._store_file().write_text(json.dumps(legacy))  # no schema_version key

    promises = followup.list_promises()

    assert [p["id"] for p in promises] == ["abc"]
    # the next save re-stamps the file going forward
    followup.mark("abc", "completed")
    on_disk = json.loads(followup._store_file().read_text())
    assert on_disk["schema_version"] == followup.SCHEMA_VERSION


def test_followup_legacy_file_load_does_not_warn(caplog):
    followup._store_file().parent.mkdir(parents=True, exist_ok=True)
    followup._store_file().write_text(json.dumps({"promises": []}))
    with caplog.at_level(logging.WARNING, logger="backend.followup"):
        followup.list_promises()
    assert not any("schema_version" in r.getMessage() for r in caplog.records)


def test_followup_higher_schema_version_logs_warning_once_per_process(caplog, monkeypatch):
    """Once-per-process gate, same idiom as inbox.state (see
    _fresh_inbox_state above): the warning fires on the first _load() that
    sees a newer schema_version and is silent on subsequent loads within
    the same process. Reset the module-level gate via monkeypatch so this
    test doesn't depend on run order relative to other tests."""
    monkeypatch.setattr(followup, "_warned_schema_version", False)
    followup._store_file().parent.mkdir(parents=True, exist_ok=True)
    future = {"promises": [_legacy_promise("x")],
              "schema_version": followup.SCHEMA_VERSION + 1}
    followup._store_file().write_text(json.dumps(future))

    with caplog.at_level(logging.WARNING, logger="backend.followup"):
        promises = followup.list_promises()
        promises_again = followup.list_promises()  # second load: gate suppresses the repeat

    assert [p["id"] for p in promises] == ["x"]  # still loads, best-effort
    assert [p["id"] for p in promises_again] == ["x"]  # data unaffected by the gate
    warnings = [
        r for r in caplog.records
        if "schema_version" in r.getMessage() and str(followup.SCHEMA_VERSION + 1) in r.getMessage()
    ]
    assert len(warnings) == 1


# --- terminals: per-session meta.json ----------------------------------------
# (read_meta/write_meta are the real evolvable per-session document -- named
# fields like persist/last_active/last_cwd. The attachment registry is
# deliberately excluded; see the module docstring above.)


def test_terminal_meta_save_stamps_schema_version():
    terminals.write_meta("meta-key", persist=True)
    on_disk = json.loads(terminals.persist_meta_path("meta-key").read_text())
    assert on_disk["schema_version"] == terminals.SCHEMA_VERSION


def test_terminal_meta_round_trips_normally_after_stamping():
    terminals.write_meta("meta-key", last_cwd="/tmp")
    assert terminals.read_meta("meta-key")["last_cwd"] == "/tmp"


def test_terminal_meta_loads_legacy_file_with_no_schema_version():
    key = "legacy-meta"
    terminals.persist_dir(key).mkdir(parents=True, exist_ok=True)
    legacy = {"persist": True, "last_cwd": "/tmp"}
    terminals.persist_meta_path(key).write_text(json.dumps(legacy))  # no schema_version key

    meta = terminals.read_meta(key)

    assert meta["last_cwd"] == "/tmp"
    # the next save re-stamps the file going forward
    terminals.write_meta(key, last_active=1.0)
    on_disk = json.loads(terminals.persist_meta_path(key).read_text())
    assert on_disk["schema_version"] == terminals.SCHEMA_VERSION


def test_terminal_meta_legacy_file_load_does_not_warn(caplog):
    key = "legacy-meta-2"
    terminals.persist_dir(key).mkdir(parents=True, exist_ok=True)
    terminals.persist_meta_path(key).write_text(json.dumps({}))
    with caplog.at_level(logging.WARNING, logger="backend.terminals"):
        terminals.read_meta(key)
    assert not any("schema_version" in r.getMessage() for r in caplog.records)


def test_terminal_meta_higher_schema_version_logs_warning_once_per_process(caplog, monkeypatch):
    """Once-per-process gate, same idiom as inbox.state (see
    _fresh_inbox_state above): the warning fires on the first read_meta()
    that sees a newer schema_version and is silent on subsequent reads
    within the same process. Reset the module-level gate via monkeypatch
    so this test doesn't depend on run order relative to other tests."""
    monkeypatch.setattr(terminals, "_warned_schema_version", False)
    key = "future-meta"
    terminals.persist_dir(key).mkdir(parents=True, exist_ok=True)
    future = {"persist": True, "schema_version": terminals.SCHEMA_VERSION + 1}
    terminals.persist_meta_path(key).write_text(json.dumps(future))

    with caplog.at_level(logging.WARNING, logger="backend.terminals"):
        meta = terminals.read_meta(key)
        meta_again = terminals.read_meta(key)  # second load: gate suppresses the repeat

    assert meta["persist"] is True  # still loads, best-effort
    assert meta_again["persist"] is True  # data unaffected by the gate
    warnings = [
        r for r in caplog.records
        if "schema_version" in r.getMessage() and str(terminals.SCHEMA_VERSION + 1) in r.getMessage()
    ]
    assert len(warnings) == 1
