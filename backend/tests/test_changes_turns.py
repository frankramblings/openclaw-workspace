import os

from backend import changes


def _touch(p, text):
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8")
    st = p.stat()
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns + 1_000_000))


def _use_root(tmp_path, monkeypatch, *roots):
    cfg = dict(changes.DEFAULT_CONFIG)
    cfg["roots"] = [str(r) for r in roots]
    monkeypatch.setattr(changes, "load_config", lambda: cfg)
    return cfg


def test_between_turn_changes_are_attributed_to_nobody(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("sk1", 1)
    changes.turn_ended("sk1", 1)      # seed
    _touch(root / "a.md", "cron wrote this between turns")
    changes.turn_started("sk1", 2)
    rec = changes.turn_ended("sk1", 2)
    assert rec["files"] == []


def test_turn_change_set_with_counts_and_diff(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "l1\nl2\nl3\n")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("sk1", 1)
    changes.turn_ended("sk1", 1)
    changes.turn_started("sk1", 2)
    _touch(root / "a.md", "l1\nL2 changed\nl3\nl4\n")
    _touch(root / "new.txt", "x\ny\n")
    rec = changes.turn_ended("sk1", 2)
    by = {f["path"]: f for f in rec["files"]}
    assert by["a.md"]["kind"] == "modified" and by["a.md"]["added"] == 2 and by["a.md"]["removed"] == 1
    assert by["new.txt"]["kind"] == "added" and by["new.txt"]["added"] == 2 and by["new.txt"]["removed"] == 0
    assert by["a.md"]["shared"] is False and by["a.md"]["root"] == str(root)
    assert changes.turn_record("sk1", 2)["turn_id"] == 2
    s = changes.session_turns("sk1")
    assert s[0]["turn_id"] == 2 and s[0]["files"] == 2 and s[0]["added"] == 4 and s[0]["removed"] == 1
    d = changes.diff_for("sk1", 2, "a.md")
    assert d["diffable"] is True and "-l2" in d["text"] and "+L2 changed" in d["text"] and "+l4" in d["text"]
    assert d["text"].splitlines()[0].startswith("--- a/a.md")
    assert changes.diff_for("sk1", 2, "missing")["diffable"] is False


def test_overlapping_turns_share_the_change(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("A", 1)
    changes.turn_ended("A", 1)
    changes.turn_started("A", 2)
    changes.turn_started("B", 7)
    _touch(root / "a.md", "two")
    recA = changes.turn_ended("A", 2)
    assert recA["files"][0]["shared"] is True and recA["shared_with"] == ["B"]
    recB = changes.turn_ended("B", 7)
    assert [f["path"] for f in recB["files"]] == ["a.md"] and recB["files"][0]["shared"] is True
    assert recB["shared_with"] == ["A"]


def test_ended_without_started_is_tolerated(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(tmp_path, monkeypatch, root)
    rec = changes.turn_ended("Z", 1)
    assert rec["turn_id"] == 1 and rec["files"] == []


def test_diff_is_capped(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "big.txt", "a\n")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("sk", 1)
    changes.turn_ended("sk", 1)
    changes.turn_started("sk", 2)
    _touch(root / "big.txt", "".join(f"{i}\n" for i in range(6000)))
    changes.turn_ended("sk", 2)
    d = changes.diff_for("sk", 2, "big.txt")
    assert len(d["text"].splitlines()) <= changes.DIFF_MAX_LINES + 1
    assert d["text"].rstrip().endswith("[diff truncated]")


def test_no_changes_leaves_shared_with_empty(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("A", 1)
    changes.turn_ended("A", 1)
    changes.turn_started("A", 2)
    changes.turn_started("B", 7)
    recA = changes.turn_ended("A", 2)
    assert recA["files"] == [] and recA["shared_with"] == []
    recB = changes.turn_ended("B", 7)
    assert recB["shared_with"] == [] and recB["files"] == []


def test_repeat_turn_ended_does_not_clobber_the_record(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("sk", 1)
    changes.turn_ended("sk", 1)
    changes.turn_started("sk", 2)
    _touch(root / "a.md", "two")
    first = changes.turn_ended("sk", 2)
    assert [f["path"] for f in first["files"]] == ["a.md"]
    again = changes.turn_ended("sk", 2)
    assert [f["path"] for f in again["files"]] == ["a.md"]
    on_disk = changes.turn_record("sk", 2)
    assert [f["path"] for f in on_disk["files"]] == ["a.md"]


def test_stale_active_turn_is_evicted_and_not_shared(tmp_path, monkeypatch):
    root = tmp_path / "ws"
    _touch(root / "a.md", "one")
    _use_root(tmp_path, monkeypatch, root)
    changes.turn_started("stuck", 1)
    key = ("stuck", 1)
    changes._ACTIVE[key]["started_ms"] -= 7 * 3600 * 1000
    changes.turn_started("other", 9)
    assert key not in changes._ACTIVE
    _touch(root / "a.md", "two")
    rec = changes.turn_ended("other", 9)
    assert rec["files"][0]["shared"] is False and rec["shared_with"] == []
