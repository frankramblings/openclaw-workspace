"""agent_config_store: private backups (0700/0600), pruning, the audit log and
the writes kill switch. config.DATA_DIR is tmp_path/data via conftest."""
import json
import logging
import os
import stat

import pytest

from backend import agent_config_store as store
from backend import config


def _mode(p):
    return stat.S_IMODE(os.stat(p).st_mode)


def test_writes_enabled_env_parsing(monkeypatch):
    monkeypatch.delenv("WORKSPACE_AGENT_CONFIG_WRITES", raising=False)
    assert store.writes_enabled() is True
    for off in ("0", "false", "no", ""):
        monkeypatch.setenv("WORKSPACE_AGENT_CONFIG_WRITES", off)
        assert store.writes_enabled() is False
    monkeypatch.setenv("WORKSPACE_AGENT_CONFIG_WRITES", "1")
    assert store.writes_enabled() is True


def test_backup_writes_private_files_and_returns_entry():
    e = store.backup("agent-file", "main/SOUL.md", "hello\n", {"action": "set"})
    assert e["kind"] == "agent-file" and e["key"] == "main/SOUL.md"
    assert e["size"] == 6 and e["sha256"] == store.sha256_text("hello\n")
    assert e["meta"] == {"action": "set"}
    d = store.base_dir() / "backups" / "agent-file" / "main__SOUL.md"
    assert (d / f"{e['id']}.txt").read_text() == "hello\n"
    assert json.loads((d / f"{e['id']}.json").read_text())["id"] == e["id"]
    assert _mode(store.base_dir()) == 0o700
    assert _mode(store.base_dir() / "backups") == 0o700
    assert _mode(store.base_dir() / "backups" / "agent-file") == 0o700
    assert _mode(d) == 0o700
    assert _mode(d / f"{e['id']}.txt") == 0o600
    assert _mode(d / f"{e['id']}.json") == 0o600
    assert config.DATA_DIR in store.base_dir().parents or store.base_dir().parent == config.DATA_DIR


def test_ensure_dir_logs_warning_on_chmod_failure(monkeypatch, caplog, tmp_path):
    def raise_once(path, mode):
        raise OSError("denied")
    monkeypatch.setattr(store.os, "chmod", raise_once)
    with caplog.at_level(logging.WARNING):
        d = store._ensure_dir(tmp_path / "new_dir")
    assert d.is_dir()
    assert any("chmod" in rec.message.lower() for rec in caplog.records)


def test_key_slug_is_filesystem_safe():
    assert store.key_slug("main/SOUL.md") == "main__SOUL.md"
    slug = store.key_slug("../../etc/passwd")
    assert slug == "..__..__etc__passwd"
    assert "/" not in slug
    assert slug not in (".", "..")
    assert store.key_slug("a b:c") == "a_b_c"
    assert store.key_slug("") == "_"
    assert store.key_slug("..") == "_"
    assert store.key_slug(".") == "_"


def test_key_slug_dot_slugs_stay_inside_backups():
    e = store.backup("..", "..", "x")
    assert e["kind"] == ".." and e["key"] == ".."
    d = store.base_dir() / "backups" / "_" / "_"
    assert (d / f"{e['id']}.txt").read_text() == "x"


def test_list_backups_newest_first_and_prune_keeps_n():
    ids = [store.backup("skill-target", "x", f"v{i}", keep=3)["id"] for i in range(5)]
    listed = store.list_backups("skill-target", "x")
    assert [b["id"] for b in listed] == list(reversed(ids[-3:]))
    assert store.read_backup("skill-target", "x", ids[-1]) == "v4"
    with pytest.raises(FileNotFoundError):
        store.read_backup("skill-target", "x", ids[0])


def test_backup_prunes_orphan_txt_without_sibling_json():
    """A crash between backup()'s two writes (<id>.txt then <id>.json) can
    leave an orphan .txt with no sibling .json; list_backups/prune are
    .json-driven and would otherwise never remove it."""
    store.backup("agent-file", "main/SOUL.md", "v1")
    d = store.base_dir() / "backups" / "agent-file" / "main__SOUL.md"
    orphan = d / "20260101T000000000000-deadbeef.txt"
    orphan.write_text("orphan content")
    assert orphan.exists()
    store.backup("agent-file", "main/SOUL.md", "v2")
    assert not orphan.exists()


def test_read_backup_rejects_bad_ids():
    store.backup("agent-file", "main/SOUL.md", "x")
    for bad in ("../../etc/passwd", "20260903T000000000000-zzzzzzzz/../x", "", "notanid"):
        with pytest.raises(FileNotFoundError):
            store.read_backup("agent-file", "main/SOUL.md", bad)


def test_list_backups_empty_when_none():
    assert store.list_backups("openclaw-json", "config") == []


def test_audit_appends_and_recent_reads_newest_first():
    store.audit("mcp.add", "vidhost", True, backup_id="b1")
    store.audit("mcp.remove", "vidhost", False, detail="boom")
    path = store.base_dir() / "audit.jsonl"
    assert _mode(path) == 0o600
    lines = path.read_text().splitlines()
    assert len(lines) == 2 and json.loads(lines[0])["action"] == "mcp.add"
    recent = store.recent_audit(50)
    assert [e["action"] for e in recent] == ["mcp.remove", "mcp.add"]
    assert recent[0]["ok"] is False and recent[0]["detail"] == "boom"
    assert recent[1]["backup_id"] == "b1"
    assert all("ts" in e for e in recent)
    assert store.recent_audit(1) == [recent[0]]
    assert store.count_audit() == 2


def test_recent_audit_tolerates_torn_last_line_and_large_files():
    for i in range(3000):
        store.audit("agent_file.set", f"main/F{i}.md", True, bytes=i)
    path = store.base_dir() / "audit.jsonl"
    with open(path, "a", encoding="utf-8") as f:
        f.write('{"ts": "x", "action": "torn"')
    recent = store.recent_audit(5)
    assert len(recent) == 5
    assert recent[0]["target"] == "main/F2999.md"
    assert path.stat().st_size > store.AUDIT_TAIL_BYTES


def test_audit_never_raises_on_oserror(caplog):
    """audit()'s target path is a directory, so os.open for append raises
    IsADirectoryError (an OSError). audit() must swallow it, log a warning,
    and still return the entry rather than raising into the caller."""
    path = store._audit_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.mkdir()
    with caplog.at_level(logging.WARNING):
        entry = store.audit("mcp.add", "x", True, backup_id="b1")
    assert entry["action"] == "mcp.add" and entry["target"] == "x" and entry["ok"] is True
    assert any("audit" in rec.message.lower() for rec in caplog.records)


def test_recent_audit_empty_without_file():
    assert store.recent_audit() == []
    assert store.count_audit() == 0
