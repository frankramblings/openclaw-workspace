"""Fix-wave regressions for the change-review subsystem (C1, I1..I3, I5, I6
and the mechanical minors). Every test here failed before its fix landed."""
import hashlib
import os
import time

import pytest

from backend import changes, config


def _touch(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def _cfg(*roots):
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["roots"] = [str(r) for r in roots]
    return cfg


def _use_root(monkeypatch, *roots):
    cfg = _cfg(*roots)
    monkeypatch.setattr(changes, "load_config", lambda: cfg)
    return cfg


# --- C1: the blob cache must never inherit the service umask ------------------

def test_blobs_are_0600_and_base_dir_0700_under_a_group_writable_umask(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "secret.md", "gateway password")
    old = os.umask(0o002)
    try:
        changes.refresh_index(str(root), _cfg(root))
    finally:
        os.umask(old)
    base = changes._base()
    assert oct(os.stat(base).st_mode & 0o777) == oct(0o700)
    blobs = list((base / "blobs").glob("*/*"))
    assert blobs
    for b in blobs:
        assert oct(os.stat(b).st_mode & 0o777) == oct(0o600), b


# --- I1: single-file roots ----------------------------------------------------

def test_single_file_root_is_indexed_modified_and_reverted(tmp_path, monkeypatch):
    f = tmp_path / "openclaw.json"
    _touch(f, '{"a": 1}\n')
    cfg = _use_root(monkeypatch, f)
    assert changes.refresh_index(str(f), cfg) == []            # seed
    idx = changes._load_index(str(f))
    assert list(idx["files"]) == ["openclaw.json"]
    assert changes.read_blob(idx["files"]["openclaw.json"][2]) == b'{"a": 1}\n'

    changes.turn_started("sk", 1)
    _touch(f, '{"a": 2}\n')
    rec = changes.turn_ended("sk", 1)
    assert [x["path"] for x in rec["files"]] == ["openclaw.json"]
    assert rec["files"][0]["kind"] == "modified"

    ok, reason = changes.revert("sk", 1, "openclaw.json")
    assert (ok, reason) == (True, "ok")
    assert f.read_text() == '{"a": 1}\n'


# --- I2: a turn that starts mid-flight must not swallow the other turn's work -

def test_turn_started_gives_pending_work_to_the_turns_already_running(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(monkeypatch, root)
    changes.turn_started("A", 1)
    _touch(root / "a.md", "A wrote this")
    changes.turn_started("B", 1)                # B opens mid-flight
    recA = changes.turn_ended("A", 1)
    recB = changes.turn_ended("B", 1)
    assert [f["path"] for f in recA["files"]] == ["a.md"]
    assert recB["files"] == []


# --- I3: never index our own data dir, whatever the prune list says -----------

def test_data_dir_is_skipped_at_any_depth_even_with_an_empty_prune_list(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "keep.md", "keep")
    data = root / "a" / "b" / "c" / "data"
    _touch(data / "sessions.json", "{}")
    _touch(root / ".claude" / "x.md", "x")
    _touch(root / ".superpowers" / "y.md", "y")
    monkeypatch.setattr(config, "DATA_DIR", data)
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["prune_dirs"] = []                       # user pruned nothing
    got = changes.scan_root(str(root), cfg)
    assert set(got) == {"keep.md"}


def test_default_prune_dirs_carry_the_always_pruned_names():
    for name in (".data", ".claude", ".superpowers"):
        assert name in changes.DEFAULT_CONFIG["prune_dirs"]


# --- I5: a corrupt blob must never be written over a live file ----------------

def test_revert_refuses_when_the_cached_pre_image_fails_its_hash(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "original\n")
    _use_root(monkeypatch, root)
    changes.turn_started("sk", 1)
    _touch(root / "a.md", "changed\n")
    rec = changes.turn_ended("sk", 1)
    before_sha = rec["files"][0]["before_sha"]
    changes.blob_path(before_sha).write_bytes(b"")      # truncated by a crash
    ok, reason = changes.revert("sk", 1, "a.md")
    assert (ok, reason) == (False, "blob_corrupt")
    assert (root / "a.md").read_text() == "changed\n"


def test_stored_blobs_match_their_hash(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "a.md", "content\n")
    changes.refresh_index(str(root), _cfg(root))
    for b in (changes._base() / "blobs").glob("*/*"):
        assert hashlib.sha256(b.read_bytes()).hexdigest() == b.name


# --- I6: a late turn_started must not orphan an _ACTIVE entry -----------------

def test_turn_started_past_its_deadline_registers_nothing(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    cfg = _use_root(monkeypatch, root)
    real = changes.refresh_index

    def slow(r, c):
        time.sleep(0.05)
        return real(r, c)

    monkeypatch.setattr(changes, "refresh_index", slow)
    changes.turn_started("sk", 1, deadline=time.monotonic() - 1)
    assert ("sk", 1) not in changes._ACTIVE
    assert cfg  # config was still consulted


def test_turn_ended_drops_orphaned_lower_turns_of_the_same_session(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(monkeypatch, root)
    changes._ACTIVE[("sk", 1)] = {"started_ms": int(time.time() * 1000), "pending": []}
    changes.turn_started("sk", 2)
    _touch(root / "a.md", "two")
    rec = changes.turn_ended("sk", 2)
    assert ("sk", 1) not in changes._ACTIVE
    assert rec["shared_with"] == []
    assert all(not f["shared"] for f in rec["files"])


# --- minors -------------------------------------------------------------------

def test_safe_key_cannot_escape_the_turns_directory():
    assert changes.safe_key("..") == "_"
    assert changes.safe_key(".") == "_"


def test_diff_does_not_glue_lines_when_a_file_lacks_a_trailing_newline(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "x\ny")
    _use_root(monkeypatch, root)
    changes.turn_started("sk", 1)
    _touch(root / "a.md", "x\nz")
    changes.turn_ended("sk", 1)
    d = changes.diff_for("sk", 1, "a.md")
    lines = d["text"].split("\n")
    assert "-y" in lines and "+z" in lines
    assert not any(line.startswith("-y+") for line in lines)


def test_refresh_skips_the_index_write_when_nothing_changed(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    cfg = _cfg(root)
    changes.refresh_index(str(root), cfg)
    p = changes.index_path(str(root))
    before = p.stat().st_mtime_ns
    time.sleep(0.01)
    assert changes.refresh_index(str(root), cfg) == []
    assert p.stat().st_mtime_ns == before
    assert "\n" not in p.read_text()             # written without indent


def test_session_turns_sort_is_stable_on_equal_end_times(tmp_path, monkeypatch):
    _use_root(monkeypatch, tmp_path / "ws")
    d = changes._base() / "turns" / "sk"
    d.mkdir(parents=True)
    for tid in (1, 2, 3):
        (d / f"{tid}.json").write_text(
            f'{{"session_key": "sk", "turn_id": {tid}, "started_ms": 1, "ended_ms": 5, "files": []}}',
            encoding="utf-8")
    assert [t["turn_id"] for t in changes.session_turns("sk")] == [3, 2, 1]


def test_sweep_removes_stale_blob_tmp_files_but_keeps_fresh_ones(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    changes.refresh_index(str(root), _cfg(root))
    bd = next((changes._base() / "blobs").glob("*"))
    old = bd / "deadbeef.tmp"
    new = bd / "cafe.tmp"
    old.write_bytes(b"x")
    new.write_bytes(b"x")
    os.utime(old, (time.time() - 7200, time.time() - 7200))
    changes.sweep()
    assert not old.exists()
    assert new.exists()


def test_stats_does_not_quarantine_a_corrupt_index(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(monkeypatch, root)
    changes.refresh_index(str(root), changes.load_config())
    p = changes.index_path(str(root))
    p.write_text("{not json", encoding="utf-8")
    out = changes.stats()
    assert out["roots"][0]["files"] == 0
    assert p.exists() and not list(p.parent.glob("*.corrupt-*"))


def test_rebuild_reports_busy_instead_of_running_twice(tmp_path, monkeypatch):
    _use_root(monkeypatch, tmp_path / "ws")
    changes._REBUILD_LOCK.acquire()
    try:
        assert changes.rebuild() == {"busy": True}
    finally:
        changes._REBUILD_LOCK.release()


def _route_client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from backend import changes_route
    app = FastAPI()
    app.include_router(changes_route.router)
    return TestClient(app)


@pytest.mark.parametrize("bad", ["x", None])
def test_revert_route_rejects_a_non_numeric_turn(bad):
    r = _route_client().post("/api/changes/revert", json={"session": "s", "turn": bad, "path": "a"})
    assert r.status_code == (422 if bad == "x" else 404)


def test_config_put_dedupes_roots_and_refuses_slash_and_nesting(tmp_path):
    c = _route_client()
    r = c.put("/api/changes/config", json={"roots": ["/a/b", "/a/b"]})
    assert r.status_code == 200 and r.json()["config"]["roots"] == ["/a/b"]
    assert c.put("/api/changes/config", json={"roots": ["/"]}).status_code == 400
    r = c.put("/api/changes/config", json={"roots": [str(tmp_path), str(tmp_path / "meetings")]})
    assert r.status_code == 400 and "overlaps" in r.json()["reason"]
    assert c.put("/api/changes/config",
                 json={"roots": [str(tmp_path / "meetings"), str(tmp_path)]}).status_code == 400
    # a shared string prefix that is not a real parent stays allowed
    assert c.put("/api/changes/config", json={"roots": ["/a/bee", "/a/beetle"]}).status_code == 200
