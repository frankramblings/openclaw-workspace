"""Per-chat attached terminal: a real PTY per workspace session, streamed to the
Hermes terminal panel over a loopback + Tailscale-Serve-guarded WebSocket.
cwd = workspace root. PR1 = human-interactive only; Gary-drive (MCP) is PR2.
Spec: docs/superpowers/specs/2026-06-16-attached-terminal-design.md
"""
from __future__ import annotations

import asyncio
import fcntl
import os
import pty
import signal
import struct
import termios
import time

from fastapi import APIRouter, HTTPException, Request, WebSocket
from starlette.websockets import WebSocketDisconnect

from . import workspace_files

router = APIRouter()

MAX_BUFFER = 120_000
DEFAULT_COLS = 96
DEFAULT_ROWS = 28


def _shell() -> str:
    return os.environ.get("SHELL") or "/bin/bash"


def terminal_access_allowed(client_host: str | None, headers) -> bool:
    """Loopback floor + Serve identity header. All legitimate traffic arrives via
    Tailscale Serve as 127.0.0.1 WITH a Tailscale-User-Login header; LAN devices
    (192.168.x) and bare local processes (no header) are refused. The
    OPENCLAW_TERMINAL_REQUIRE_TSHEADER=0 escape relaxes to loopback-only — the
    lockout safeguard if a deployment lacks Serve identity."""
    if client_host not in ("127.0.0.1", "::1"):
        return False
    if os.environ.get("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "1") == "0":
        return True
    return bool(headers.get("tailscale-user-login"))


class PtySession:
    """One PTY-backed shell for a chat session. start() spawns the process and
    opens the master fd; drain_once() pulls available bytes (used by tests and by
    the asyncio reader); attach_reader() wires it into a running loop so output
    fans out to subscriber queues live."""

    def __init__(self, session_key: str, *, cols: int = DEFAULT_COLS, rows: int = DEFAULT_ROWS):
        self.session_key = session_key
        self.cols = cols
        self.rows = rows
        self.master_fd: int | None = None
        self.pid: int | None = None
        self.buffer = ""
        self.exited = False
        self.exit_code: int | None = None
        self._subscribers: set[asyncio.Queue] = set()
        self._reader_loop: asyncio.AbstractEventLoop | None = None

    def start(self) -> None:
        # Precompute everything BEFORE the fork: building dicts/lists in the child
        # of a (previously) multithreaded process is unsafe; the child only
        # chdir+execs precomputed values.
        cwd = str(workspace_files.workspace_root())
        shell = _shell()
        argv = [shell, "-i"]
        env = dict(os.environ)
        env["TERM"] = env.get("TERM") or "xterm-256color"
        env["OPENCLAW_ATTACHED_TERMINAL"] = "1"

        pid, master_fd = pty.fork()
        if pid == 0:  # child: become the shell (slave is already stdio + ctty)
            try:
                os.chdir(cwd)
                os.execvpe(shell, argv, env)
            except BaseException:
                os._exit(127)
        self.pid = pid
        self.master_fd = master_fd
        flags = fcntl.fcntl(master_fd, fcntl.F_GETFL)
        fcntl.fcntl(master_fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        self.resize(self.cols, self.rows)

    def _append(self, text: str) -> None:
        self.buffer += text
        if len(self.buffer) > MAX_BUFFER:
            self.buffer = self.buffer[-MAX_BUFFER:]

    def drain_once(self) -> str:
        """Read whatever is available without blocking; append to the scrollback
        buffer; detect child exit on EOF. Returns the newly-read text."""
        if self.master_fd is None or self.exited:
            return ""
        chunks: list[bytes] = []
        while True:
            try:
                data = os.read(self.master_fd, 65536)
            except (BlockingIOError, InterruptedError):
                break
            except OSError:
                data = b""  # master closed -> child gone
            if data == b"":
                self._mark_exited()
                break
            chunks.append(data)
        text = b"".join(chunks).decode("utf-8", "replace")
        if text:
            self._append(text)
        return text

    def _reap(self, *, block: bool) -> None:
        """Reap the child if possible; record exit_code only on an actual reap.

        WNOHANG returning (0, 0) means the child is still alive (or not yet
        reapable) — leave self.pid set so a later call retries. exit_code is
        recorded ONLY when waitpid returns a real pid (i.e. an actual reap)."""
        if self.pid is None:
            return
        try:
            wpid, status = os.waitpid(self.pid, 0 if block else os.WNOHANG)
        except (ChildProcessError, OSError):
            self.pid = None  # already reaped (or never a real child)
            return
        if wpid == 0:
            return  # WNOHANG: not exited yet — keep pid so a later call retries
        self.exit_code = os.waitstatus_to_exitcode(status)
        self.pid = None

    def _mark_exited(self) -> None:
        # EOF/error path: the child has exited (slave side closed). Stop reads
        # and reap best-effort without blocking the asyncio reader.
        self.exited = True
        self._reap(block=False)

    def write(self, data: str) -> None:
        if self.master_fd is None or self.exited:
            return
        try:
            os.write(self.master_fd, data.encode("utf-8"))
        except OSError:
            self._mark_exited()

    def resize(self, cols: int, rows: int) -> None:
        self.cols, self.rows = cols, rows
        if self.master_fd is None:
            return
        winsize = struct.pack("HHHH", rows, cols, 0, 0)  # ws_row, ws_col, xpix, ypix
        try:
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    def close(self) -> None:
        # Idempotent: safe to call twice, and safe if start() never set a pid.
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None
        # GUARANTEE the child is reaped — no zombie left behind. Give SIGHUP a
        # brief, bounded window to land, then escalate to SIGKILL and block.
        for _ in range(10):  # ~0.2s total
            self._reap(block=False)
            if self.pid is None:
                break
            time.sleep(0.02)
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            self._reap(block=True)
        self.exited = True
        self._detach_reader()

    # --- live streaming (used by the WS handler, not by the unit tests) ---
    def attach_reader(self, loop: asyncio.AbstractEventLoop) -> None:
        if self.master_fd is None or self._reader_loop is not None:
            return
        self._reader_loop = loop
        loop.add_reader(self.master_fd, self._on_readable)

    def _on_readable(self) -> None:
        text = self.drain_once()
        if text:
            for q in list(self._subscribers):
                q.put_nowait(("output", text))
        if self.exited:
            for q in list(self._subscribers):
                q.put_nowait(("exit", self.exit_code))
            self._detach_reader()

    def _detach_reader(self) -> None:
        if self._reader_loop is not None and self.master_fd is not None:
            try:
                self._reader_loop.remove_reader(self.master_fd)
            except (OSError, ValueError):
                pass
        self._reader_loop = None

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subscribers.discard(q)


_sessions: dict[str, PtySession] = {}


def get_or_create(session_key: str, *, cols: int = DEFAULT_COLS, rows: int = DEFAULT_ROWS) -> PtySession:
    sess = _sessions.get(session_key)
    if sess is None or sess.exited:
        sess = PtySession(session_key, cols=cols, rows=rows)
        sess.start()
        _sessions[session_key] = sess
    return sess


def close_session(session_key: str) -> None:
    sess = _sessions.pop(session_key, None)
    if sess:
        sess.close()
