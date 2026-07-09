"""backend.fsutil — atomic content writes + advisory file locking.

Covers the contract later tasks import: atomic_write_text, atomic_write_json,
file_lock. See fsutil.py's module docstring for the locking scope limit (our
side only — the vault is also written by a separate agent process)."""
from __future__ import annotations

import threading
import time

import pytest

from backend import fsutil


def test_atomic_write_text_round_trips_byte_identical(tmp_path):
    p = tmp_path / "note.md"
    text = "hello\nworld — emoji 🎈 and tabs\t here\n"
    fsutil.atomic_write_text(p, text)
    assert p.read_text(encoding="utf-8") == text


def test_atomic_write_text_preserves_original_when_replace_fails(tmp_path, monkeypatch):
    p = tmp_path / "note.md"
    p.write_text("original content")

    def _boom(*a, **kw):
        raise OSError("simulated failure mid-write")

    monkeypatch.setattr(fsutil.os, "replace", _boom)
    with pytest.raises(OSError):
        fsutil.atomic_write_text(p, "new content that must not land")

    # original file untouched...
    assert p.read_text() == "original content"
    # ...and no tmp litter left behind in the directory.
    leftover = [f for f in tmp_path.iterdir() if f != p]
    assert leftover == []


def test_atomic_write_text_leaves_no_tmp_litter_on_new_file_failure(tmp_path, monkeypatch):
    p = tmp_path / "brand-new.md"
    assert not p.exists()

    def _boom(*a, **kw):
        raise OSError("simulated failure mid-write")

    monkeypatch.setattr(fsutil.os, "replace", _boom)
    with pytest.raises(OSError):
        fsutil.atomic_write_text(p, "content")

    assert not p.exists()
    assert list(tmp_path.iterdir()) == []


def test_atomic_write_json_dumps_pretty_and_round_trips(tmp_path):
    p = tmp_path / "data.json"
    obj = {"b": 1, "a": ["x", "y"], "unicode": "héllo"}
    fsutil.atomic_write_json(p, obj)
    raw = p.read_text(encoding="utf-8")
    assert "\n  " in raw  # indent=2
    assert "h\\u00e9llo" not in raw  # ensure_ascii=False
    import json
    assert json.loads(raw) == obj


def test_file_lock_serializes_two_threads(tmp_path):
    p = tmp_path / "shared.txt"
    events: list[str] = []
    start_second = threading.Event()

    def first():
        with fsutil.file_lock(p):
            events.append("first-acquired")
            start_second.set()
            time.sleep(0.2)
            events.append("first-released")

    def second():
        start_second.wait()
        # Give the first thread a moment to actually be inside its critical
        # section before we race for the lock.
        with fsutil.file_lock(p):
            events.append("second-acquired")

    t1 = threading.Thread(target=first)
    t2 = threading.Thread(target=second)
    t1.start()
    t2.start()
    t1.join()
    t2.join()

    assert events == ["first-acquired", "first-released", "second-acquired"]


def test_file_lock_timeout_raises_timeout_error(tmp_path):
    p = tmp_path / "shared.txt"
    holder_ready = threading.Event()
    release_holder = threading.Event()

    def holder():
        with fsutil.file_lock(p):
            holder_ready.set()
            release_holder.wait(timeout=5)

    t = threading.Thread(target=holder)
    t.start()
    holder_ready.wait(timeout=5)
    try:
        with pytest.raises(TimeoutError):
            with fsutil.file_lock(p, timeout=0.2):
                pass  # pragma: no cover - must not be reached
    finally:
        release_holder.set()
        t.join()


def test_file_lock_is_reentrant_safe_after_release(tmp_path):
    """Sequential acquire/release on the same path from the same process must
    not deadlock (regression guard for save-then-reload style call chains)."""
    p = tmp_path / "shared.txt"
    with fsutil.file_lock(p):
        pass
    with fsutil.file_lock(p, timeout=0.5):
        pass
