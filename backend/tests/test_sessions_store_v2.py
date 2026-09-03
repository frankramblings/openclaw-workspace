"""Schema v2: `opened` (OPEN-shelf membership) and `parent_id` (fork parent)
on every session record, with a v1 file migrating in place (spec §4.1)."""
import json

from backend import sessions_store


def _mk(**kw):
    base = dict(name="t", model=None, endpoint_url=None, endpoint_id=None, speed=None)
    base.update(kw)
    return sessions_store.create(**base)


def test_create_has_v2_fields_defaulting_to_none():
    rec = _mk()
    assert rec["opened"] is None
    assert rec["parent_id"] is None
    assert sessions_store.SCHEMA_VERSION == 2


def test_v1_file_migrates_on_load(monkeypatch, tmp_path):
    f = tmp_path / "sessions.json"
    f.write_text(json.dumps({"schema_version": 1, "sessions": [
        {"id": "abc", "name": "old", "sessionKey": "agent:main:web-abc", "created": 1, "updated": 1},
    ]}))
    monkeypatch.setattr(sessions_store, "_STORE_FILE", f)
    rec = sessions_store.get("abc")
    assert rec["opened"] is None and rec["parent_id"] is None
    assert sessions_store.list_sessions()[0]["parent_id"] is None
    # first write persists the bumped version
    sessions_store.update("abc", name="renamed")
    assert json.loads(f.read_text())["schema_version"] == 2


def test_legacy_file_without_version_also_migrates(monkeypatch, tmp_path):
    f = tmp_path / "sessions.json"
    f.write_text(json.dumps({"sessions": [{"id": "x1", "name": "n", "sessionKey": "k"}]}))
    monkeypatch.setattr(sessions_store, "_STORE_FILE", f)
    assert sessions_store.get("x1")["opened"] is None


def test_update_accepts_opened_and_parent_id():
    rec = _mk()
    out = sessions_store.update(rec["id"], opened=123, parent_id="p1")
    assert out["opened"] == 123 and out["parent_id"] == "p1"
    out = sessions_store.update(rec["id"], opened=None)
    assert out["opened"] is None


def test_mark_and_close_opened():
    rec = _mk()
    out = sessions_store.mark_opened(rec["id"])
    assert isinstance(out["opened"], int) and out["opened"] > 0
    out = sessions_store.close_opened(rec["id"])
    assert out["opened"] is None
    assert sessions_store.mark_opened("nope") is None


def test_close_opened_does_not_bump_updated(monkeypatch):
    # M3: closing a shelf row is not activity — it must not move the thread
    # to the top of RECENT or bump its project's latest roll-up. _now_ms is
    # faked to distinct, increasing values so this can't pass by accident on
    # two calls landing in the same millisecond.
    times = iter([1000, 2000, 3000, 4000, 5000])
    monkeypatch.setattr(sessions_store, "_now_ms", lambda: next(times))
    rec = _mk()
    sessions_store.mark_opened(rec["id"])
    before = sessions_store.get(rec["id"])["updated"]
    out = sessions_store.close_opened(rec["id"])
    assert out["opened"] is None
    assert out["updated"] == before
