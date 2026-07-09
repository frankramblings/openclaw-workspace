"""Tier-A terminal persistence: on-disk scrollback store + secret scrubber.
The autouse conftest fixture points config.DATA_DIR at a tmp dir, so every
store call here writes under tmp_path, never the live .data/ store."""

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


def test_flush_persists_pending_output_and_meta():
    sess = terminals.PtySession("flush-key")
    sess.pid = None  # no real /proc; read_cwd -> None
    sess._persist_pending = "line1\n"
    sess.flush_persist(force=True)
    assert "line1" in terminals.load_tail("flush-key")
    meta = terminals.read_meta("flush-key")
    assert "last_active" in meta and meta["persist"] is True
    assert sess._persist_pending == ""


def test_flush_is_gated_when_not_forced():
    sess = terminals.PtySession("gate-key")
    sess.pid = None
    sess._persist_last_flush = terminals.time.monotonic()  # just flushed
    sess._persist_pending = "tiny"
    sess.flush_persist(force=False)  # under interval + under byte threshold
    assert terminals.load_tail("gate-key") == ""  # nothing written yet
    assert sess._persist_pending == "tiny"        # still pending


def test_incognito_session_never_writes():
    terminals.set_persist("incog-key", False)
    sess = terminals.PtySession("incog-key")
    assert sess.persist is False
    sess._persist_pending = "should not persist"
    sess.flush_persist(force=True)
    assert terminals.load_tail("incog-key") == ""
    assert sess._persist_pending == ""


def test_restore_cwd_prefers_existing_saved_dir(tmp_path):
    key = "restore-cwd"
    terminals.set_persist(key, True)
    terminals.write_meta(key, last_cwd=str(tmp_path))      # exists
    assert terminals._restore_cwd(key) == str(tmp_path)
    terminals.write_meta(key, last_cwd=str(tmp_path / "gone"))  # missing
    assert terminals._restore_cwd(key) is None
    terminals.set_persist(key, False)
    terminals.write_meta(key, last_cwd=str(tmp_path), persist=False)
    assert terminals._restore_cwd(key) is None             # incognito -> no restore


def test_restore_separator_contains_marker_and_cwd():
    sep = terminals._restore_separator("/home/admin/project")
    assert "restored" in sep and "/home/admin/project" in sep


def test_get_or_create_seeds_buffer_from_log():
    key = "restore-seed"
    terminals.append_output(key, "yesterday output\n")
    sess = terminals.get_or_create(key)
    try:
        assert "yesterday output" in sess.buffer
        assert "restored" in sess.buffer  # separator present
    finally:
        terminals.close_session(key)


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(terminals.router)
    return TestClient(app)


def test_persist_endpoints_roundtrip():
    c = _client()
    key = "ep-key"
    headers = {"tailscale-user-login": "tester@example.com"}
    assert c.get(f"/api/terminal/{key}/persist", headers=headers).json() == {"enabled": True}
    assert c.post(f"/api/terminal/{key}/persist", json={"enabled": False}, headers=headers).json() == {"enabled": False}
    assert terminals.is_persist_enabled(key) is False


def test_clear_history_endpoint_wipes_log():
    c = _client()
    key = "ep-clear"
    headers = {"tailscale-user-login": "tester@example.com"}
    terminals.append_output(key, "stuff")
    assert c.post(f"/api/terminal/{key}/clear-history", headers=headers).json() == {"ok": True}
    assert terminals.load_tail(key) == ""


def test_persist_endpoints_require_auth():
    """Verify that GET/POST /persist and POST /clear-history return 403 without auth header."""
    c = _client()
    key = "ep-auth"
    # No tailscale-user-login header; TestClient default host is "testclient" (not loopback)
    # so terminal_access_allowed() should reject the request.
    assert c.get(f"/api/terminal/{key}/persist").status_code == 403
    assert c.post(f"/api/terminal/{key}/persist", json={"enabled": False}).status_code == 403
    assert c.post(f"/api/terminal/{key}/clear-history").status_code == 403
