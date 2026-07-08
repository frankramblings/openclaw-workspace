"""Attached-terminal backend: PTY lifecycle, scrollback cap, and the
loopback+Serve-identity access guard. PR1 (human-interactive)."""
import time

import pytest

from backend import config, terminals


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


# --- Truth table (see the comment above terminal_access_allowed for the
# authoritative statement). Cells:
#   (a) WORKSPACE_AUTH_TOKEN/session auth active         -> allow (unchanged)
#   (b) no auth configured + Tailscale identity header    -> allow (unchanged)
#   (c) no auth + loopback + NO Tailscale header           -> DENY by default,
#       allow only with OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK=1 (CHANGED)
#   (d) non-loopback, no auth, no header                   -> deny (unchanged)
#   (e) Gary-drive/MCP: loopback + capability_ok=True       -> allow, still
#       requires loopback (matches "token + gary_mode + loopback")
# Plus: OPENCLAW_TERMINAL_REQUIRE_TSHEADER=0 (legacy escape hatch) keeps
# unconditionally allowing everything, and now implies the new opt-in.


@pytest.fixture(autouse=True)
def _no_auth_gate(monkeypatch):
    # Cell (a) is exercised by its own tests below; keep every other test on
    # the pre-task-14 default (auth gate off) so they aren't accidentally
    # short-circuited to True by a stray env var on the dev box.
    monkeypatch.setattr(config, "auth_token", lambda: None)
    monkeypatch.setattr(config, "auth_session_secret", lambda: None)


def test_guard_denies_plain_loopback_without_header_by_default():
    # (c), the changed cell: bare loopback is NO LONGER sufficient on its
    # own — a same-host reverse proxy (nginx/Caddy) makes every proxied
    # client look like 127.0.0.1 here, so trusting loopback unconditionally
    # handed out a real shell to anyone the proxy fronted.
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is False
    assert terminals.terminal_access_allowed("::1", {}) is False


def test_guard_allows_plain_loopback_with_opt_in_env(monkeypatch):
    # (c), the opt-in escape hatch: an operator who has verified their
    # loopback path is trustworthy (e.g. no reverse proxy) can flip this on.
    monkeypatch.setenv("OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK", "1")
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is True
    assert terminals.terminal_access_allowed("::1", {}) is True


def test_guard_plain_loopback_opt_in_requires_exact_value(monkeypatch):
    # Only "1" opts in — any other truthy-looking string stays denied, same
    # convention as OPENCLAW_TERMINAL_REQUIRE_TSHEADER.
    monkeypatch.setenv("OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK", "true")
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is False


def test_guard_allows_serve_tailnet_user_via_header():
    # (b) Through Serve, uvicorn surfaces the tailnet client IP, not loopback;
    # the injected identity header is what authenticates the request. This is
    # Frank's production path and must keep working unchanged.
    assert terminals.terminal_access_allowed(
        "100.64.1.2", {"tailscale-user-login": "frank@example.com"}
    ) is True


def test_guard_allows_loopback_with_header_too():
    # (b) as literally stated in the truth table: loopback + header also
    # allows (the header alone is sufficient, loopback or not).
    assert terminals.terminal_access_allowed(
        "127.0.0.1", {"tailscale-user-login": "frank@example.com"}
    ) is True


def test_guard_rejects_remote_without_identity_header():
    # (d) A remote (non-loopback) request with no Serve identity header is
    # refused.
    assert terminals.terminal_access_allowed("100.64.1.2", {}) is False


def test_guard_override_allows_remote_without_header(monkeypatch):
    # Legacy escape hatch: unconditional allow, no loopback requirement.
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")
    assert terminals.terminal_access_allowed("100.64.1.2", {}) is True


def test_guard_require_tsheader_zero_implies_plain_loopback_opt_in(monkeypatch):
    # REQUIRE_TSHEADER=0 already meant "I accept loopback trust" before this
    # task; it must keep allowing bare loopback WITHOUT also setting the new
    # OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK flag.
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")
    monkeypatch.delenv("OPENCLAW_TERMINAL_ALLOW_PLAIN_LOOPBACK", raising=False)
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is True
    assert terminals.terminal_access_allowed("::1", {}) is True


def test_guard_capability_ok_allows_loopback_without_header():
    # (e) Gary-drive/MCP: a resolved per-turn capability token + loopback
    # allows even under the new default-deny, so Gary's own loopback curl
    # calls (mint_terminal_token) don't regress in the common no-token,
    # no-Serve deployment.
    assert terminals.terminal_access_allowed(
        "127.0.0.1", {}, capability_ok=True
    ) is True
    assert terminals.terminal_access_allowed(
        "::1", {}, capability_ok=True
    ) is True


def test_guard_capability_ok_does_not_bypass_loopback_requirement():
    # The audit's invariant — "token + gary_mode + loopback" — means the
    # capability token is NOT sufficient on its own; a non-loopback caller is
    # still denied even with a resolvable token.
    assert terminals.terminal_access_allowed(
        "100.64.1.2", {}, capability_ok=True
    ) is False


def test_guard_allows_when_auth_gate_active(monkeypatch):
    # (a) When WORKSPACE_AUTH_TOKEN/session auth is configured, AuthGateMiddleware
    # (auth_gate.py) wraps the whole app and rejects any unauthenticated
    # request before it ever reaches a router handler — none of the
    # /api/terminal/* routes are on its allowlist. So reaching this function
    # at all, while auth is active, already proves the caller authenticated;
    # a remote client with no Tailscale header and no loopback is allowed.
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    assert terminals.terminal_access_allowed("203.0.113.5", {}) is True


def test_guard_allows_when_session_auth_active(monkeypatch):
    # (a) also covers the session-cookie-only variant (WORKSPACE_AUTH_SECRET /
    # SHARE_SECRET without a bare token) — config.auth_active() is the single
    # source of truth for "is AuthGateMiddleware enforcing auth right now".
    monkeypatch.setattr(config, "auth_session_secret", lambda: b"some-secret")
    assert terminals.terminal_access_allowed("203.0.113.5", {}) is True


# --- Cell (a), end-to-end: prove the two-layer design actually composes —
# AuthGateMiddleware (auth_gate.py) plus terminal_access_allowed together —
# not just the bare function in isolation above. Uses the real app so a
# valid WORKSPACE_AUTH_TOKEN is checked by the SAME middleware stack that
# runs in production. /persist is a lightweight route (no PTY spawn).

from fastapi.testclient import TestClient  # noqa: E402 - intentionally scoped to this section (house style)

from backend.app import app as _full_app  # noqa: E402 - intentionally scoped to this section (house style)


def test_e2e_valid_auth_token_allows_terminal_route_without_header(monkeypatch):
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    client = TestClient(_full_app, client=("203.0.113.5", 51234))
    r = client.get("/api/terminal/e2e-key/persist",
                   headers={"Authorization": "Bearer secret-token"})
    assert r.status_code == 200, r.text


def test_e2e_missing_auth_token_denied_before_reaching_terminal_guard(monkeypatch):
    # auth_active() being true is not itself a free pass — it requires an
    # actual valid credential at the OUTER (AuthGateMiddleware) layer first.
    monkeypatch.setattr(config, "auth_token", lambda: "secret-token")
    client = TestClient(_full_app, client=("203.0.113.5", 51234))
    r = client.get("/api/terminal/e2e-key/persist")
    assert r.status_code == 401


def test_get_or_create_reuses_live_session():
    a = terminals.get_or_create("reuse-key")
    b = terminals.get_or_create("reuse-key")
    try:
        assert a is b
    finally:
        terminals.close_session("reuse-key")
