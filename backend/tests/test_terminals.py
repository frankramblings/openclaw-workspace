"""Attached-terminal backend: PTY lifecycle, scrollback cap, and the
loopback+Serve-identity access guard. PR1 (human-interactive)."""
import time

import pytest

from backend import terminals


def _spin(sess, needle, timeout=8.0):
    """PTY output is async; poll drain_once() until the needle shows up.
    Deadline-based (not fixed-iteration) so a slow cold `bash -i`/`zsh` spawn on
    a loaded box doesn't exhaust the budget before the prompt lands."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        sess.drain_once()
        if needle in sess.buffer:
            return True
        time.sleep(0.02)
    return False


@pytest.fixture(autouse=True)
def _require_header(monkeypatch):
    # Default-on header enforcement; tests set it explicitly so a stray env
    # override on the dev box can't flip guard behavior under us.
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "1")


def test_pty_echoes_written_command():
    sess = terminals.PtySession("test-echo")
    sess.start()
    try:
        sess.write("printf HELLO_PTY_OK\n")
        assert _spin(sess, "HELLO_PTY_OK")
    finally:
        sess.close()


def test_pty_cwd_is_workspace_root():
    sess = terminals.PtySession("test-cwd")
    sess.start()
    try:
        sess.write("pwd\n")
        root = str(terminals.workspace_files.workspace_root())
        assert _spin(sess, root)
    finally:
        sess.close()


def test_buffer_is_capped():
    sess = terminals.PtySession("test-cap")
    sess.start()
    try:
        sess._append("x" * (terminals.MAX_BUFFER + 5000))
        assert len(sess.buffer) == terminals.MAX_BUFFER
    finally:
        sess.close()


def test_close_marks_exited():
    sess = terminals.PtySession("test-exit")
    sess.start()
    sess.close()
    assert sess.exited is True


def test_close_reaps_child_no_zombie():
    sess = terminals.PtySession("test-reap")
    sess.start()
    pid = sess.pid
    sess.close()
    assert sess.exited is True
    # Child must be fully reaped — waiting on it again raises (no zombie left).
    import os
    import pytest as _pytest
    with _pytest.raises(ChildProcessError):
        os.waitpid(pid, os.WNOHANG)


def test_guard_allows_local_loopback_without_header():
    # On-box callers (health checks, local curl) — already have shell access.
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is True
    assert terminals.terminal_access_allowed("::1", {}) is True


def test_guard_allows_serve_tailnet_user_via_header():
    # Through Serve, uvicorn surfaces the tailnet client IP, not loopback; the
    # injected identity header is what authenticates the request.
    assert terminals.terminal_access_allowed(
        "100.64.1.2", {"tailscale-user-login": "frank@example.com"}
    ) is True


def test_guard_rejects_remote_without_identity_header():
    # A remote (non-loopback) request with no Serve identity header is refused.
    assert terminals.terminal_access_allowed("100.64.1.2", {}) is False


def test_guard_override_allows_remote_without_header(monkeypatch):
    # The escape hatch trusts the 127.0.0.1 bind and allows all.
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")
    assert terminals.terminal_access_allowed("100.64.1.2", {}) is True


def test_get_or_create_reuses_live_session():
    a = terminals.get_or_create("reuse-key")
    b = terminals.get_or_create("reuse-key")
    try:
        assert a is b
    finally:
        terminals.close_session("reuse-key")
