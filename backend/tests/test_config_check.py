"""Task 15: startup config validation.

config_check.run() is the pre-serve sanity pass wired into app.py's lifespan
(before the app starts accepting requests): it re-validates the numeric env
vars the backend casts with int()/float(), makes sure ~/.openclaw/openclaw.json
still parses, checks the vault root exists, flags likely WORKSPACE_*/
OPENCLAW_*/INBOX_* env-var typos, and probes .data/ for writability.

Everything EXCEPT the .data/ writability probe is soft: a problem is
collected into the returned list (and the caller logs it with log.warning)
but run() itself never raises for these — a bad WORKSPACE_STALL_CAP must not
stop the app from booting. .data/ being unwritable is the one condition the
app genuinely cannot recover from (every store write fails from that point
on), so that check raises instead of returning a string.

Numeric env vars are two layers sharing one parse (config.parse_env_number):
config._env_int/_env_float degrade a bad value to the call site's default
with a logged warning (crucially: also at module-IMPORT time, where 9 of the
11 casts live — a bad value used to kill `import backend.app` with a raw
ValueError before any check could run), and config_check re-reports the same
bad var as a startup problem string.
"""
from __future__ import annotations

import json
import logging
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from backend import config, config_check


# --- Numeric env vars: the config._env_int/_env_float degrade layer -----------

def test_env_float_helper_degrades_to_default_and_warns(monkeypatch, caplog):
    monkeypatch.setenv("WORKSPACE_STALL_CAP", "24o")  # the classic finger slip
    with caplog.at_level(logging.WARNING, logger="backend.config"):
        assert config._env_float("WORKSPACE_STALL_CAP", 240.0) == 240.0
    assert any("WORKSPACE_STALL_CAP" in r.getMessage() for r in caplog.records)


def test_env_int_helper_degrades_to_default_and_warns(monkeypatch, caplog):
    monkeypatch.setenv("SHARE_SESSION_DAYS", "thirty")
    with caplog.at_level(logging.WARNING, logger="backend.config"):
        assert config._env_int("SHARE_SESSION_DAYS", 30) == 30
    assert any("SHARE_SESSION_DAYS" in r.getMessage() for r in caplog.records)


def test_env_helpers_parse_valid_values_and_pass_through_unset(monkeypatch):
    monkeypatch.setenv("WORKSPACE_STALL_CAP", "300")
    assert config._env_float("WORKSPACE_STALL_CAP", 240.0) == 300.0
    monkeypatch.delenv("WORKSPACE_STALL_CAP")
    assert config._env_float("WORKSPACE_STALL_CAP", 240.0) == 240.0
    monkeypatch.setenv("SHARE_SESSION_DAYS", "7")
    assert config._env_int("SHARE_SESSION_DAYS", 30) == 7


def test_bad_numeric_env_var_before_import_degrades_and_is_reported():
    """The real crash scenario the review flagged: WORKSPACE_STALL_CAP is cast
    at module-import time, so a bad value present BEFORE `import
    backend.config` used to raise ValueError during the import itself —
    unreachable by any in-process test that monkeypatches env afterwards.
    Prove the whole contract in a fresh interpreter: the import survives, the
    constant degrades to its default (240.0), the degrade warning reaches
    stderr, and config_check.run() still reports the var as a problem."""
    repo_root = Path(config_check.__file__).resolve().parent.parent
    env = dict(os.environ, WORKSPACE_STALL_CAP="not-a-number")
    code = (
        "import backend.config as c, backend.config_check as cc\n"
        "print(c.STALL_CAP_S)\n"
        "print(any('WORKSPACE_STALL_CAP' in p for p in cc.run()))\n"
    )
    proc = subprocess.run([sys.executable, "-c", code], cwd=repo_root, env=env,
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    lines = proc.stdout.splitlines()
    assert lines[0] == "240.0"   # degraded to the default, not crashed
    assert lines[1] == "True"    # ...and still reported by config_check
    assert "WORKSPACE_STALL_CAP" in proc.stderr  # the import-time warning


# --- Numeric env vars: the config_check report layer ---------------------------

def test_bad_numeric_env_var_is_reported_by_run(monkeypatch):
    monkeypatch.setenv("WORKSPACE_STALL_CAP", "not-a-number")
    problems = config_check.run()
    assert any("WORKSPACE_STALL_CAP" in p for p in problems)


def test_bad_int_env_var_is_reported(monkeypatch):
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", "eighteen-seven-eight-nine")
    problems = config_check.run()
    assert any("OPENCLAW_GATEWAY_PORT" in p for p in problems)


def test_valid_numeric_env_vars_produce_no_numeric_problem(monkeypatch):
    monkeypatch.setenv("WORKSPACE_STALL_CAP", "300")
    monkeypatch.setenv("OPENCLAW_GATEWAY_PORT", "18789")
    problems = config_check.run()
    assert not any("WORKSPACE_STALL_CAP" in p for p in problems)
    assert not any("OPENCLAW_GATEWAY_PORT" in p for p in problems)


def test_unset_numeric_env_var_is_not_a_problem(monkeypatch):
    for name, _caster, _default in config_check.NUMERIC_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    problems = config_check.run()
    assert not any(
        name in p for name, _c, _d in config_check.NUMERIC_ENV_VARS for p in problems
    )


def test_all_config_py_numeric_vars_are_covered():
    """Task 15 asks for the config.py:~130-135 family (+ anywhere else config
    casts env) enumerated by reading the source. Pin the concrete set found
    there so a future edit to config.py that adds a new int()/float() cast
    has to touch this list too."""
    names = {name for name, _c, _d in config_check.NUMERIC_ENV_VARS}
    assert names == {
        "OPENCLAW_GATEWAY_PORT",
        "WORKSPACE_TURN_TIMEOUT_S",
        "WORKSPACE_STALL_NOTICE",
        "WORKSPACE_STALL_CAP",
        "SHARE_SESSION_DAYS",
        "WORKSPACE_RESEARCH_TURN_TIMEOUT_S",
        "INBOX_GMAIL_LIST",
        "SLACK_STALE_MIN",
        "SLACK_THREAD_RECENT_HOURS",
        "DOCS_STALE_DAYS",
        "OBSIDIAN_WINDOW_DAYS",
    }


# --- ~/.openclaw/openclaw.json ------------------------------------------------

def test_missing_openclaw_json_is_not_a_problem(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", tmp_path / "nope" / "openclaw.json")
    problems = config_check.run()
    assert not any("openclaw.json" in p for p in problems)


def test_valid_openclaw_json_is_not_a_problem(tmp_path, monkeypatch):
    path = tmp_path / "openclaw.json"
    path.write_text(json.dumps({"gateway": {"port": 18789}}))
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", path)
    problems = config_check.run()
    assert not any("openclaw.json" in p for p in problems)


def test_corrupt_openclaw_json_is_reported(tmp_path, monkeypatch):
    path = tmp_path / "openclaw.json"
    path.write_text("{not valid json")
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", path)
    problems = config_check.run()
    assert any("openclaw.json" in p for p in problems)


def test_non_utf8_openclaw_json_is_reported_not_raised(tmp_path, monkeypatch):
    """UnicodeDecodeError is a ValueError, not an OSError — a non-UTF-8
    openclaw.json must degrade to a problem string like any other corrupt
    config, not escape the advisory check and abort boot."""
    path = tmp_path / "openclaw.json"
    path.write_bytes(b"\xff\xfe\x00bad")
    monkeypatch.setattr(config, "OPENCLAW_CONFIG", path)
    problems = config_check.run()  # must not raise
    assert any("openclaw.json" in p for p in problems)


# --- Vault root ----------------------------------------------------------------

def test_missing_vault_root_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "OPENCLAW_HOME", tmp_path / "no-such-home")
    problems = config_check.run()
    assert any("vault" in p.lower() for p in problems)


def test_existing_vault_root_is_not_a_problem(tmp_path, monkeypatch):
    home = tmp_path / "home"
    (home / "workspace").mkdir(parents=True)
    monkeypatch.setattr(config, "OPENCLAW_HOME", home)
    problems = config_check.run()
    assert not any("vault" in p.lower() for p in problems)


# --- .data/ writability (the one fatal check) ----------------------------------

def test_data_dir_writable_does_not_raise(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    config_check.run()  # must not raise
    # the probe file must not be left behind
    leftover = list((tmp_path / "data").iterdir()) if (tmp_path / "data").exists() else []
    assert leftover == []


@pytest.mark.skipif(os.geteuid() == 0, reason="chmod 000 does not block root")
def test_data_dir_unwritable_raises(tmp_path, monkeypatch):
    locked = tmp_path / "locked"
    locked.mkdir()
    os.chmod(locked, stat.S_IREAD | stat.S_IEXEC)  # r-x, no write
    monkeypatch.setattr(config, "DATA_DIR", locked / "data")
    try:
        with pytest.raises(Exception):  # noqa: B017 - any exception is fatal here
            config_check.run()
    finally:
        os.chmod(locked, stat.S_IRWXU)  # let tmp_path cleanup succeed


@pytest.mark.skipif(os.geteuid() == 0, reason="chmod does not block root")
def test_fatal_data_check_logs_accumulated_advisory_problems_before_raising(
        tmp_path, monkeypatch, caplog):
    """When the fatal .data check fires, run() raises and the caller never
    sees the returned list — the advisory findings gathered up to that point
    must be logged by run() itself, not silently dropped."""
    monkeypatch.setenv("WORKSPACE_STALL_CAP", "not-a-number")  # advisory problem
    locked = tmp_path / "locked"
    locked.mkdir()
    os.chmod(locked, stat.S_IREAD | stat.S_IEXEC)
    monkeypatch.setattr(config, "DATA_DIR", locked / "data")
    try:
        with caplog.at_level(logging.WARNING, logger="backend.config_check"):
            with pytest.raises(Exception):  # noqa: B017
                config_check.run()
    finally:
        os.chmod(locked, stat.S_IRWXU)
    assert any("WORKSPACE_STALL_CAP" in r.getMessage() for r in caplog.records)


# --- Typo detector (warn-only) --------------------------------------------------

def test_unknown_workspace_env_var_flagged_as_possible_typo(monkeypatch):
    monkeypatch.setenv("WORKSPACE_ZZZ", "1")
    problems = config_check.run()
    assert any("WORKSPACE_ZZZ" in p and "typo" in p.lower() for p in problems)
    monkeypatch.delenv("WORKSPACE_ZZZ", raising=False)


def test_real_env_var_is_not_flagged_as_typo(monkeypatch):
    monkeypatch.setenv("WORKSPACE_AGENT_NAME", "Gary")
    problems = config_check.run()
    assert not any("WORKSPACE_AGENT_NAME" in p for p in problems)


def test_unrelated_env_var_is_ignored_by_typo_detector(monkeypatch):
    monkeypatch.setenv("PATH_TO_SOMETHING_RANDOM", "1")
    problems = config_check.run()
    assert not any("PATH_TO_SOMETHING_RANDOM" in p for p in problems)


def test_typo_allowlist_matches_grep_of_backend_source():
    """Guards KNOWN_ENV_VARS from silently drifting out of sync with the real
    env vars the backend reads: re-derives the allowlist by grepping every
    non-test backend/*.py file for WORKSPACE_*/OPENCLAW_*/INBOX_* string
    literals passed to os.environ.get/os.getenv/os.environ[], the same way
    the list below was originally built.

    LIMITATION (see config_check module docstring): this only catches
    *literal* double-quoted env-var names. A name built dynamically (an
    f-string, a variable) would be invisible to both this grep and the
    typo detector itself — the allowlist is a curated snapshot, not a
    runtime-exhaustive one."""
    backend_dir = Path(config_check.__file__).resolve().parent
    pattern = re.compile(r'"((?:WORKSPACE|OPENCLAW|INBOX)_[A-Z0-9_]+)"')
    found: set[str] = set()
    for path in backend_dir.rglob("*.py"):
        rel = path.relative_to(backend_dir)
        if "tests" in rel.parts or "__pycache__" in rel.parts:
            continue
        found |= set(pattern.findall(path.read_text(encoding="utf-8")))
    assert found == config_check.KNOWN_ENV_VARS


# --- Integration: a bad numeric env var must not stop the app booting ---------

def test_app_still_starts_and_logs_warning_with_bad_numeric_env_var(monkeypatch, caplog):
    from backend import app as app_module

    monkeypatch.setenv("WORKSPACE_STALL_CAP", "not-a-number")
    with caplog.at_level(logging.WARNING, logger="backend.app"):
        with TestClient(app_module.app) as client:
            resp = client.get("/api/health")
    assert resp.status_code == 200
    assert any("WORKSPACE_STALL_CAP" in r.getMessage() for r in caplog.records)
