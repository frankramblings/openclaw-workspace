import os
import time

from backend import changes


def _touch(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def _cfg(monkeypatch, root):
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["roots"] = [str(root)]
    monkeypatch.setattr(changes, "load_config", lambda: cfg)
    return cfg


def test_sweep_drops_old_records_and_orphan_blobs(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _cfg(monkeypatch, root)
    changes.turn_started("sk", 1)
    changes.turn_ended("sk", 1)
    changes.turn_started("sk", 2)
    _touch(root / "a.md", "two")
    changes.turn_ended("sk", 2)
    old_sha = changes.turn_record("sk", 2)["files"][0]["before_sha"]
    assert changes.read_blob(old_sha) == b"one"
    # young record: nothing removed, old blob still referenced by the record
    assert changes.sweep(keep_days=30) == {"records_removed": 0, "blobs_removed": 0}
    # age the record past retention: record goes, orphan blob "one" goes, "two" stays (in index)
    far = int(time.time() * 1000) + 40 * 86400 * 1000
    out = changes.sweep(now_ms=far, keep_days=30)
    assert out["records_removed"] == 2 and out["blobs_removed"] == 1
    assert changes.read_blob(old_sha) is None
    assert changes.turn_record("sk", 2) is None
    assert changes.read_blob(changes._load_index(str(root))["files"]["a.md"][2]) == b"two"


def test_rebuild_and_stats(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _touch(root / "b.md", "two")
    _cfg(monkeypatch, root)
    out = changes.rebuild()
    assert out == {"roots": 1, "files": 2}
    st = changes.stats()
    assert st["blobs"] == 2 and st["blob_bytes"] == 6
    assert st["roots"][0]["files"] == 2 and st["roots"][0]["exists"] is True
    assert st["rebuild"]["running"] is False
