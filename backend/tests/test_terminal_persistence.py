"""Tier-A terminal persistence: on-disk scrollback store + secret scrubber.
The autouse conftest fixture points config.DATA_DIR at a tmp dir, so every
store call here writes under tmp_path, never the live .data/ store."""
import json
import os
import time

from backend import terminals


def test_scrub_masks_known_secret_shapes():
    samples = [
        "token ghp_" + "a" * 36,
        "key sk-" + "B" * 40,
        "aws AKIA" + "1234567890ABCDEF",
        "jwt eyJabc.eyJdef.sig_part-123",
        "-----BEGIN OPENSSH PRIVATE KEY-----\nABC\n-----END OPENSSH PRIVATE KEY-----",
    ]
    for s in samples:
        out = terminals.scrub(s)
        assert "***REDACTED***" in out, s
    # PEM body must not survive
    assert "ABC" not in terminals.scrub(samples[-1])


def test_scrub_leaves_ordinary_output_intact():
    text = "total 12\ndrwxr-xr-x  3 admin staff 96 file.py\nskim the docs\n"
    assert terminals.scrub(text) == text  # 'skim' must not trip the sk- rule


def test_append_enforces_rolling_cap_and_perms():
    terminals.PERSIST_CAP  # sanity: constant exists
    key = "cap-key"
    terminals.append_output(key, "A" * (terminals.PERSIST_CAP + 5000))
    p = terminals.persist_log_path(key)
    assert p.stat().st_size == terminals.PERSIST_CAP
    assert (p.stat().st_mode & 0o777) == 0o600
    assert (terminals.persist_dir(key).stat().st_mode & 0o777) == 0o700


def test_load_tail_round_trips():
    key = "tail-key"
    terminals.append_output(key, "hello ")
    terminals.append_output(key, "world")
    assert terminals.load_tail(key) == "hello world"
    assert terminals.load_tail("never-written") == ""


def test_persist_flag_default_and_toggle_clears_log():
    key = "flag-key"
    assert terminals.is_persist_enabled(key) is True   # default on
    terminals.append_output(key, "secretish output")
    terminals.set_persist(key, False)
    assert terminals.is_persist_enabled(key) is False
    assert terminals.load_tail(key) == ""              # log wiped on disable


def test_clear_removes_session_dir():
    key = "clear-key"
    terminals.append_output(key, "data")
    assert terminals.persist_dir(key).exists()
    terminals.clear_persist(key)
    assert not terminals.persist_dir(key).exists()


def test_prune_removes_idle_keeps_fresh():
    now = 1_000_000.0
    terminals.append_output("old", "x")
    terminals.write_meta("old", last_active=now - 31 * 86400)
    terminals.append_output("fresh", "y")
    terminals.write_meta("fresh", last_active=now - 1 * 86400)
    removed = terminals.prune_persist(max_idle_days=30, now=now)
    assert removed == 1
    assert not terminals.persist_dir("old").exists()
    assert terminals.persist_dir("fresh").exists()


def test_read_cwd_seam(monkeypatch):
    assert terminals.read_cwd(None) is None
    # nonexistent pid -> None (no /proc entry / not linux)
    assert terminals.read_cwd(2_000_000_000) is None


def test_scrub_left_boundary_prevents_false_positives():
    """Regression: negative lookbehind ensures we don't redact 'task-12345...' or
    '/dev/disk-0123...' that merely contain 'sk-' or 'AKIA' as a substring."""
    # These should NOT be redacted (no boundary match):
    assert terminals.scrub("task-12345678901234567890") == "task-12345678901234567890"
    assert terminals.scrub("/dev/disk-0123456789abcdefghij") == "/dev/disk-0123456789abcdefghij"

    # These SHOULD be redacted (real secrets with proper boundary):
    secret_sk = "export KEY=sk-" + "B" * 40
    assert "***REDACTED***" in terminals.scrub(secret_sk)

    secret_ghp = "token ghp_" + "a" * 36
    assert "***REDACTED***" in terminals.scrub(secret_ghp)
