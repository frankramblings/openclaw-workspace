import json
import os
import stat

from backend import changes


def _touch(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def _setup(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _touch(root / "gone.txt", "bye")
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["roots"] = [str(root)]
    monkeypatch.setattr(changes, "load_config", lambda: cfg)
    notified = []
    monkeypatch.setattr(changes, "_notify_watch", lambda p: notified.append(p))
    changes.turn_started("sk", 1)
    changes.turn_ended("sk", 1)
    changes.turn_started("sk", 2)
    _touch(root / "a.md", "two")
    _touch(root / "new.py", "print(1)")
    (root / "gone.txt").unlink()
    changes.turn_ended("sk", 2)
    return root, notified


def test_revert_modified_added_deleted(tmp_path, monkeypatch):
    root, notified = _setup(tmp_path, monkeypatch)
    assert changes.revert("sk", 2, "a.md") == (True, "ok")
    assert (root / "a.md").read_text() == "one"
    assert changes.revert("sk", 2, "new.py") == (True, "ok")
    assert not (root / "new.py").exists()
    assert changes.revert("sk", 2, "gone.txt") == (True, "ok")
    assert (root / "gone.txt").read_text() == "bye"
    assert sorted(os.path.basename(p) for p in notified) == ["a.md", "gone.txt", "new.py"]
    rec = changes.turn_record("sk", 2)
    assert all(f["reverted"] for f in rec["files"])
    # the revert itself is not a new change for the next turn
    changes.turn_started("sk", 3)
    assert changes.turn_ended("sk", 3)["files"] == []


def test_revert_refused_when_file_moved_on(tmp_path, monkeypatch):
    root, _ = _setup(tmp_path, monkeypatch)
    _touch(root / "a.md", "three")
    assert changes.revert("sk", 2, "a.md") == (False, "file_changed_since")
    assert (root / "a.md").read_text() == "three"


def test_revert_twice_and_unknown(tmp_path, monkeypatch):
    _setup(tmp_path, monkeypatch)
    assert changes.revert("sk", 2, "a.md") == (True, "ok")
    assert changes.revert("sk", 2, "a.md") == (False, "already_reverted")
    assert changes.revert("sk", 2, "nope") == (False, "not_found")
    assert changes.revert("sk", 99, "a.md") == (False, "not_found")


def test_revert_preserves_mode_and_cleans_failed_write(tmp_path, monkeypatch):
    root, _ = _setup(tmp_path, monkeypatch)
    os.chmod(root / "a.md", 0o600)
    assert changes.revert("sk", 2, "a.md") == (True, "ok")
    if os.geteuid() != 0:
        assert stat.S_IMODE(os.stat(root / "a.md").st_mode) == 0o600

    if os.geteuid() != 0:
        root2, _ = _setup(tmp_path / "b", monkeypatch)
        os.chmod(root2, 0o500)
        try:
            assert changes.revert("sk", 2, "a.md") == (False, "io_error")
            assert list(root2.glob("*.revert-tmp")) == []
        finally:
            os.chmod(root2, 0o700)


def test_revert_survives_missing_index_and_reseeds_next_turn(tmp_path, monkeypatch):
    # Turn 3 starts (seeding a clean index) before the index file is lost, so
    # turn_ended below - not an intervening turn_started - is the first
    # refresh to see the missing index; that is what actually surfaces a
    # poisoned index as spurious "added" reports for untouched files.
    root, _ = _setup(tmp_path, monkeypatch)
    changes.turn_started("sk", 3)
    changes.index_path(str(root)).unlink()
    assert changes.revert("sk", 2, "a.md") == (True, "ok")
    assert changes.turn_ended("sk", 3)["files"] == []


def test_revert_refuses_relative_or_missing_root(tmp_path, monkeypatch):
    root, _ = _setup(tmp_path, monkeypatch)
    rec_path = changes.record_path("sk", 2)
    rec = json.loads(rec_path.read_text())
    for entry in rec["files"]:
        if entry["path"] == "a.md":
            entry["root"] = ""
    rec_path.write_text(json.dumps(rec), encoding="utf-8")
    assert changes.revert("sk", 2, "a.md") == (False, "not_found")
    assert (root / "a.md").read_text() == "two"
