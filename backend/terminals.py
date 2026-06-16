"""Per-chat attached terminal: a real PTY per workspace session, streamed to the
Hermes terminal panel over a loopback + Tailscale-Serve-guarded WebSocket.
cwd = workspace root. PR1 = human-interactive only; Gary-drive (MCP) is PR2.
Spec: docs/superpowers/specs/2026-06-16-attached-terminal-design.md
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import os
import pty
import secrets
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
    """Authenticate terminal access.

    uvicorn binds 127.0.0.1 only, so the LAN cannot reach this port at all — the
    sole remote path is Tailscale Serve, which injects a `Tailscale-User-Login`
    identity header for the authenticated tailnet user. Behind Serve, uvicorn
    surfaces the *tailnet* client IP (via X-Forwarded-For), NOT loopback, so we
    must key on the identity header, not the client IP (the original loopback
    check rejected every Serve request). Genuine on-box loopback callers
    (health checks, local curl) are always allowed — they already have shell.
    OPENCLAW_TERMINAL_REQUIRE_TSHEADER=0 trusts the 127.0.0.1 bind and allows all
    — the escape hatch if a deployment's Serve lacks identity headers."""
    if client_host in ("127.0.0.1", "::1"):
        return True
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
    # Always-on reader: keep `buffer` current even with no WebSocket attached, so
    # Gary's MCP read/run see live output. attach_reader is idempotent.
    try:
        sess.attach_reader(asyncio.get_running_loop())
    except RuntimeError:
        pass  # no running loop (sync unit tests) — WS/endpoints attach later
    return sess


def close_session(session_key: str) -> None:
    sess = _sessions.pop(session_key, None)
    if sess:
        sess.close()


# --- Gary-drive: per-turn token map -----------------------------------------
# A short-lived token mints a capability to drive ONE chat's PTY, handed to the
# loopback MCP server for a single turn. Tokens expire (TTL) and are pruned
# lazily so the map can't grow unbounded.
_TERMINAL_TOKENS: dict[str, tuple[str, float]] = {}
TERMINAL_TOKEN_TTL = 1800.0


def _prune_terminal_tokens() -> None:
    now = time.time()
    for t in [t for t, (_, exp) in _TERMINAL_TOKENS.items() if exp <= now]:
        _TERMINAL_TOKENS.pop(t, None)


def mint_terminal_token(session_key: str) -> str:
    _prune_terminal_tokens()
    token = secrets.token_urlsafe(18)
    _TERMINAL_TOKENS[token] = (session_key, time.time() + TERMINAL_TOKEN_TTL)
    return token


def resolve_terminal_token(token: str) -> str | None:
    _prune_terminal_tokens()
    entry = _TERMINAL_TOKENS.get(token)
    return entry[0] if entry else None


# --- Gary-mode resolution ---------------------------------------------------
# Effective state = per-session override if set, else the global default (ON).
def gary_mode_default() -> bool:
    from . import websearch
    return bool(websearch.load_settings().get("gary_terminal_default", True))


def gary_mode_for_session(session_key: str) -> bool:
    from . import sessions_store
    override = sessions_store.gary_terminal_override(session_key)
    return override if isinstance(override, bool) else gary_mode_default()


@router.websocket("/api/terminal/{session_key}/stream")
async def terminal_stream(websocket: WebSocket, session_key: str):
    client_host = websocket.client.host if websocket.client else None
    if not terminal_access_allowed(client_host, websocket.headers):
        await websocket.close(code=1008)  # refused at handshake -> HTTP 403
        return
    await websocket.accept()
    loop = asyncio.get_running_loop()
    sess = get_or_create(session_key)
    sess.attach_reader(loop)
    # Replay scrollback so a reopened panel is continuous.
    if sess.buffer:
        await websocket.send_json({"type": "output", "data": sess.buffer})
    if sess.exited:
        await websocket.send_json({"type": "exit", "code": sess.exit_code})
    queue = sess.subscribe()

    async def pump_out():
        try:
            while True:
                kind, payload = await queue.get()
                if kind == "output":
                    await websocket.send_json({"type": "output", "data": payload})
                elif kind == "exit":
                    await websocket.send_json({"type": "exit", "code": payload})
        except (WebSocketDisconnect, RuntimeError):
            pass  # peer gone; the receive loop tears down

    out_task = asyncio.create_task(pump_out())
    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
            if mtype == "input":
                sess.write(msg.get("data", ""))
            elif mtype == "resize":
                try:
                    cols = int(msg.get("cols", DEFAULT_COLS))
                    rows = int(msg.get("rows", DEFAULT_ROWS))
                except (ValueError, TypeError):
                    continue
                sess.resize(cols, rows)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        out_task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await out_task
        sess.unsubscribe(queue)


@router.post("/api/terminal/{session_key}/close")
async def terminal_close(session_key: str, request: Request):
    client_host = request.client.host if request.client else None
    if not terminal_access_allowed(client_host, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    close_session(session_key)
    return {"ok": True}


# --- Gary-drive: loopback MCP-facing endpoints ------------------------------
async def _await_settled_output(sess, cursor, settle=1.2, cap=20.0):
    """Wait until the PTY buffer stops growing for `settle` seconds (or `cap`
    elapses), then return everything written since `cursor`."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + cap
    last_len = len(sess.buffer)
    quiet_until = loop.time() + settle
    while loop.time() < deadline:
        await asyncio.sleep(0.1)
        if len(sess.buffer) != last_len:
            last_len = len(sess.buffer)
            quiet_until = loop.time() + settle
        elif loop.time() >= quiet_until:
            break
    return sess.buffer[cursor:]


@router.post("/api/terminal/mcp/run")
async def terminal_mcp_run(request: Request):
    body = await request.json()
    session_key = resolve_terminal_token(str(body.get("token", "")))
    if not session_key:
        raise HTTPException(status_code=404, detail="invalid or expired terminal token")
    if not gary_mode_for_session(session_key):
        raise HTTPException(status_code=403, detail="Gary terminal control is off for this chat")
    sess = get_or_create(session_key)
    sess.attach_reader(asyncio.get_running_loop())
    cursor = len(sess.buffer)
    sess.write(str(body.get("command", "")) + "\n")
    output = await _await_settled_output(sess, cursor, cap=float(body.get("timeout", 20)))
    return {"output": output, "exited": sess.exited, "exit_code": sess.exit_code}


@router.post("/api/terminal/mcp/read")
async def terminal_mcp_read(request: Request):
    body = await request.json()
    session_key = resolve_terminal_token(str(body.get("token", "")))
    if not session_key:
        raise HTTPException(status_code=404, detail="invalid or expired terminal token")
    sess = _sessions.get(session_key)
    tail = int(body.get("tail", 4000))
    return {"output": (sess.buffer[-tail:] if sess else ""), "running": bool(sess and not sess.exited)}


@router.post("/api/terminal/mcp/write")
async def terminal_mcp_write(request: Request):
    body = await request.json()
    session_key = resolve_terminal_token(str(body.get("token", "")))
    if not session_key:
        raise HTTPException(status_code=404, detail="invalid or expired terminal token")
    if not gary_mode_for_session(session_key):
        raise HTTPException(status_code=403, detail="Gary terminal control is off for this chat")
    sess = get_or_create(session_key)
    sess.attach_reader(asyncio.get_running_loop())
    sess.write(str(body.get("data", "")))
    return {"ok": True}
