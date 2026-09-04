"""Portable runtime defaults: every tenant-specific value (paths, names,
hosts) derives from HOME, REPO_ROOT, or the config knobs, never a literal
Frank/Gary/home-frank path baked into the module."""
import json
import os
import subprocess
import sys

from backend import app as app_module
from backend import changes, config, followup, promise_guard
from backend.inbox import settings as inbox_settings


def test_default_roots_follow_home_and_repo(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    roots = changes.default_roots()
    assert roots == [
        str(tmp_path / ".openclaw" / "workspace"),
        str(config.REPO_ROOT),
        str(tmp_path / ".openclaw" / "openclaw.json"),
    ]
    # roots[1] is config.REPO_ROOT verbatim (Task 1's portable constant,
    # unaffected by HOME). The equality check above already proves it is
    # wired correctly. This worktree's own checkout happens to live under
    # /home/frank on this dev machine, so only the HOME-derived roots get
    # the "no hardcoded Frank path" check here.
    assert not any("/home/frank" in r for r in (roots[0], roots[2]))


def test_load_config_uses_default_roots_when_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    # conftest.py's autouse _isolated_data_dir fixture blanks
    # DEFAULT_CONFIG["roots"] to [] so unrelated tests never scan real
    # directories; restore the production wiring here so this test exercises
    # the real default instead of the test-isolation stub.
    monkeypatch.setattr(changes, "DEFAULT_CONFIG",
                         {**changes.DEFAULT_CONFIG, "roots": changes.default_roots()})
    roots = changes.load_config()["roots"]
    assert roots == changes.default_roots()
    # See test_default_roots_follow_home_and_repo: roots[1] is REPO_ROOT,
    # which legitimately lives under /home/frank on this dev machine.
    assert not any("/home/frank" in r for r in (roots[0], roots[2]))


def test_default_config_roots_wired_at_import(tmp_path):
    result = subprocess.run(
        [sys.executable, "-c",
         "from backend import changes; import json; "
         "print(json.dumps(changes.DEFAULT_CONFIG['roots']))"],
        cwd=config.REPO_ROOT,
        env={**os.environ, "HOME": str(tmp_path)},
        capture_output=True, text=True, check=True,
    )
    assert json.loads(result.stdout) == [
        str(tmp_path / ".openclaw" / "workspace"),
        str(config.REPO_ROOT),
        str(tmp_path / ".openclaw" / "openclaw.json"),
    ]


def test_entities_dir_fallback_follows_home(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    monkeypatch.delenv("INBOX_ENTITIES_DIR", raising=False)
    monkeypatch.setattr(inbox_settings, "inbox_config", lambda: {})
    assert inbox_settings.entities_dir() == (
        tmp_path / ".openclaw" / "workspace" / "OpenClaw_Vault" / "20_Reference" / "Knowledge" / "Entities")


def test_preamble_uses_configured_names(monkeypatch):
    monkeypatch.setattr(config, "user_name", lambda: "Marissa")
    monkeypatch.setattr(config, "agent_name", lambda: "Bob")
    text = app_module._build_preamble([{"role": "user", "text": "hi"}, {"role": "assistant", "text": "yo"}])
    assert "Marissa: hi" in text and "Bob: yo" in text and "Frank" not in text


def test_prompts_use_configured_user_name(monkeypatch):
    monkeypatch.setattr(config, "user_name", lambda: "Marissa")
    seed = promise_guard._wake_seed("I'll check back")
    assert "Marissa" in seed and "Frank" not in seed
    assert "Frank" not in followup._followup_prompt_probe()


def test_local_host_drives_embed_and_stt_defaults(monkeypatch):
    # No importlib.reload here: chat_search computes _DB_PATH from
    # config.DATA_DIR at module load, and conftest's autouse fixture
    # monkeypatches config.DATA_DIR per test, so a reload would permanently
    # rebind _DB_PATH to a deleted tmp dir (monkeypatch cannot undo a reload)
    # and reset _reindex_lock / _matrix_cache under any existing import
    # holder. Exercise the default-builder functions directly instead.
    import backend.chat_search as cs
    import backend.transcribe as tr
    monkeypatch.setenv("WORKSPACE_LOCAL_HOST", "10.9.8.7")
    assert cs._default_embed_url() == "http://10.9.8.7:11434/api/embed"
    assert tr._default_stt_base() == "http://10.9.8.7:9000"
    # The module constants were bound at import time from whatever host was
    # configured then; just confirm they still honor their own env names.
    assert cs._EMBED_URL.startswith("http")
    assert tr._KAMINO_STT.startswith("http")
