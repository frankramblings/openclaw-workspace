import os
import time

from backend import changes, config


def _touch(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    # make mtime strictly move even on coarse filesystems
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def _cfg(root):
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["roots"] = [str(root)]
    return cfg


def test_scan_prunes_dirs_and_skips_binary_ext_and_big_files(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "a.md", "hello")
    _touch(root / ".venv-x" / "lib" / "big.py", "x")
    _touch(root / "node_modules" / "m.js", "x")
    _touch(root / "img.png", "\x89PNG")
    (root / "huge.txt").write_bytes(b"x" * (changes.DEFAULT_CONFIG["max_bytes"] + 1))
    _touch(root / "sub" / "b.py", "print(1)")
    got = changes.scan_root(str(root), _cfg(root))
    assert set(got) == {"a.md", "sub/b.py"}
    assert all(isinstance(v, tuple) and len(v) == 2 for v in got.values())


def test_scan_single_file_root_and_missing_root(tmp_path):
    f = tmp_path / "openclaw.json"
    _touch(f, "{}")
    assert list(changes.scan_root(str(f), _cfg(f))) == ["openclaw.json"]
    assert changes.scan_root(str(tmp_path / "nope"), _cfg(tmp_path)) == {}


def test_refresh_first_run_seeds_without_reporting(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    cfg = _cfg(root)
    assert changes.refresh_index(str(root), cfg) == []          # seed = silent
    idx = changes._load_index(str(root))
    assert "a.md" in idx["files"] and len(idx["files"]["a.md"]) == 3
    sha = idx["files"]["a.md"][2]
    assert changes.read_blob(sha) == b"one"


def test_refresh_reports_added_modified_deleted_with_blobs(tmp_path):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _touch(root / "gone.txt", "bye")
    cfg = _cfg(root)
    changes.refresh_index(str(root), cfg)
    time.sleep(0.01)
    _touch(root / "a.md", "two")
    _touch(root / "new.py", "print(2)")
    (root / "gone.txt").unlink()
    out = {c["path"]: c for c in changes.refresh_index(str(root), cfg)}
    assert set(out) == {"a.md", "new.py", "gone.txt"}
    a = out["a.md"]
    assert a["kind"] == "modified" and a["diffable"] is True
    assert changes.read_blob(a["before_sha"]) == b"one"
    assert changes.read_blob(a["after_sha"]) == b"two"
    assert a["before_bytes"] == 3 and a["after_bytes"] == 3
    n = out["new.py"]
    assert n["kind"] == "added" and n["before_sha"] is None and changes.read_blob(n["after_sha"]) == b"print(2)"
    g = out["gone.txt"]
    assert g["kind"] == "deleted" and g["after_sha"] is None and changes.read_blob(g["before_sha"]) == b"bye"
    assert changes.refresh_index(str(root), cfg) == []          # stable afterwards


def test_binary_content_is_indexed_but_not_diffable(tmp_path):
    root = tmp_path / "ws"
    p = root / "blob.dat"
    root.mkdir()
    p.write_bytes(b"\x00\x01\x02")
    cfg = _cfg(root)
    changes.refresh_index(str(root), cfg)
    time.sleep(0.01)
    p.write_bytes(b"\x00\x01\x02\x03")
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))
    out = changes.refresh_index(str(root), cfg)
    assert out[0]["kind"] == "modified" and out[0]["diffable"] is False
    assert out[0]["after_sha"] is not None and changes.read_blob(out[0]["after_sha"]) is None


def test_config_roundtrip_creates_defaults(tmp_path):
    cfg = changes.load_config()
    assert cfg["roots"] == changes.DEFAULT_CONFIG["roots"]
    assert (config.DATA_DIR / "changes.json").exists()
    cfg["roots"] = ["/tmp/x"]
    changes.save_config(cfg)
    assert changes.load_config()["roots"] == ["/tmp/x"]
