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
    out = changes.sweep(keep_days=30)
    assert out["records_removed"] == 0 and out["blobs_removed"] == 0
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


def test_sweep_removes_corrupt_record_file(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _cfg(monkeypatch, root)
    changes.turn_started("sk", 1)
    changes.turn_ended("sk", 1)
    changes.turn_started("sk", 2)
    _touch(root / "a.md", "two")
    changes.turn_ended("sk", 2)
    safe_key = changes.safe_key("sk")
    record_dir = changes._base() / "turns" / safe_key
    corrupt_record = record_dir / "9.json"
    corrupt_record.parent.mkdir(parents=True, exist_ok=True)
    corrupt_record.write_bytes(b"{not json")
    assert corrupt_record.exists()
    far = int(time.time() * 1000) + 40 * 86400 * 1000
    out = changes.sweep(now_ms=far, keep_days=30)
    assert corrupt_record.exists() is False
    assert out["records_removed"] == 3
    quarantine_files = list(record_dir.glob("*.corrupt-*"))
    assert len(quarantine_files) == 0


def test_sweep_removes_corrupt_index_file(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "data")
    _cfg(monkeypatch, root)
    changes.refresh_index(str(root), changes.load_config())
    import hashlib
    only_in_corrupt_sha = hashlib.sha256(b"only_in_corrupt").hexdigest()
    blob_path = changes.blob_path(only_in_corrupt_sha)
    blob_path.parent.mkdir(parents=True, exist_ok=True)
    blob_path.write_bytes(b"only_in_corrupt")
    idx_dir = changes._base() / "index"
    root_key = changes.root_key(str(root))
    corrupt_idx = idx_dir / f"{root_key}.corrupt-fake"
    corrupt_idx.write_text('{"files": {"x.txt": [0, 15, "' + only_in_corrupt_sha + '"]}}')
    out = changes.sweep()
    assert corrupt_idx.exists() is False
    assert blob_path.exists() is False
    assert out["index_quarantines_removed"] == 1
