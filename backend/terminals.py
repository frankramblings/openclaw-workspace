"""Per-chat attached terminal: a real PTY per workspace session, streamed to the
Hermes terminal panel over a loopback + Tailscale-Serve-guarded WebSocket.
cwd = workspace root. PR1 = human-interactive only; Gary-drive (MCP) is PR2.
Spec: docs/superpowers/specs/2026-06-16-attached-terminal-design.md
"""
from __future__ import annotations

import asyncio
import contextlib
import fcntl
import json
import os
import pty
import re
import secrets
import shutil
import signal
import struct
import termios
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket
from starlette.websockets import WebSocketDisconnect

from . import config
from . import workspace_files

router = APIRouter()

MAX_BUFFER = 120_000

# --- Scrollback persistence (Tier A) tunables ---
PERSIST_DIRNAME = "terminals"
PERSIST_CAP = 1_000_000          # rolling per-session scrollback.log byte cap
PERSIST_FLUSH_INTERVAL = 1.0     # seconds; batched flush, never per-keystroke
PERSIST_FLUSH_BYTES = 65536      # or flush once this many bytes pend
PERSIST_PRUNE_IDLE_DAYS = 30

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
        self.total_written = 0
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
        env["OPENCLAW_SESSION_KEY"] = self.session_key

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
        self.total_written += len(text)
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
    try:
        _attachments_path(session_key).unlink()
    except (FileNotFoundError, OSError):
        pass


# --- Terminal image attachments: per-session token → file registry ----------
# Images dropped/pasted into a chat's terminal are uploaded via /api/upload
# (bytes land in uploads.ATTACH_DIR, inside Gary's vault) and registered here.
# A "[name.ext]" token is typed into the PTY; the registry maps it to the saved
# path. `pending` is True until a chat turn consumes the image as a vision
# attachment; the token→path mapping itself persists for the session lifetime so
# an in-terminal CLI can resolve it any time.
def _attachments_dir() -> Path:
    return config.DATA_DIR / "terminal_attachments"


def _sanitize_key(session_key: str) -> str:
    safe = "".join(c for c in (session_key or "") if c.isalnum() or c in "-_")
    return safe or "global"


def _attachments_path(session_key: str) -> Path:
    return _attachments_dir() / (_sanitize_key(session_key) + ".json")


def _load_attachments(session_key: str) -> dict:
    try:
        return json.loads(_attachments_path(session_key).read_text())
    except (FileNotFoundError, ValueError, OSError):
        return {}


def _save_attachments(session_key: str, data: dict) -> None:
    p = _attachments_path(session_key)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data))
    tmp.replace(p)


def _unique_token(reg: dict, base: str, ext: str) -> str:
    cand = f"[{base}{ext}]"
    if cand not in reg:
        return cand
    n = 2
    while f"[{base}-{n}{ext}]" in reg:
        n += 1
    return f"[{base}-{n}{ext}]"


def register_attachment(session_key: str, file_id: str,
                        name: str | None = None, mime: str | None = None) -> str:
    """Register an uploaded image for a chat's terminal; return its [token]."""
    if not file_id or file_id != Path(file_id).name or file_id in (".", ".."):
        raise ValueError("invalid file_id")
    from .uploads import ATTACH_DIR
    reg = _load_attachments(session_key)
    ext = Path(file_id).suffix or (Path(name).suffix if name else "") or ""
    stem = Path(name).stem if name else ""
    if stem:
        base = stem
    else:
        n = sum(1 for t in reg if t.startswith("[pasted-")) + 1
        base = f"pasted-{n}"
    token = _unique_token(reg, base, ext)
    reg[token] = {
        "id": file_id,
        "name": name or (base + ext),
        "path": str(ATTACH_DIR / file_id),
        "mime": mime or "",
        "ts": int(time.time()),
        "pending": True,
    }
    _save_attachments(session_key, reg)
    return token


def list_attachments(session_key: str, pending_only: bool = False) -> list[dict]:
    reg = _load_attachments(session_key)
    out = []
    for token, e in reg.items():
        if pending_only and not e.get("pending"):
            continue
        out.append({"token": token, **e})
    return out


def resolve_attachment(session_key: str, token: str) -> str | None:
    reg = _load_attachments(session_key)
    e = reg.get(token)
    if e is None and token and not token.startswith("["):
        e = reg.get(f"[{token}]")
    return e.get("path") if e else None


def mark_consumed(session_key: str, tokens: list[str]) -> None:
    reg = _load_attachments(session_key)
    changed = False
    for t in tokens:
        if t in reg and reg[t].get("pending"):
            reg[t]["pending"] = False
            changed = True
    if changed:
        _save_attachments(session_key, reg)


# --- Scrollback persistence (Tier A): per-session on-disk contents + cwd -----
# Persists terminal OUTPUT (never keystrokes) so a chat's terminal contents and
# working directory survive reboots. Files are 0o600 under a 0o700 dir. A
# best-effort scrubber masks well-known secret shapes before writing — NOT a
# guarantee; full-disk encryption is the primary at-rest control.

_SECRET_PATTERNS = [
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"sk-[A-Za-z0-9]{20,}"),
    re.compile(r"AKIA[0-9A-Z]{16}"),
    re.compile(r"eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"),
    re.compile(
        r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----.*?"
        r"-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----",
        re.DOTALL,
    ),
]


def scrub(text: str) -> str:
    """Mask well-known secret token shapes. Defense-in-depth, not a guarantee."""
    for pat in _SECRET_PATTERNS:
        text = pat.sub("***REDACTED***", text)
    return text


def _persist_base() -> Path:
    return config.DATA_DIR / PERSIST_DIRNAME


def persist_dir(session_key: str) -> Path:
    return _persist_base() / _sanitize_key(session_key)


def persist_log_path(session_key: str) -> Path:
    return persist_dir(session_key) / "scrollback.log"


def persist_meta_path(session_key: str) -> Path:
    return persist_dir(session_key) / "meta.json"


def append_output(session_key: str, text: str) -> None:
    """Scrub then append OUTPUT to the rolling log (0o600), capped at PERSIST_CAP."""
    if not text:
        return
    text = scrub(text)
    d = persist_dir(session_key)
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    p = persist_log_path(session_key)
    try:
        with open(p, "a", encoding="utf-8", errors="replace") as f:
            f.write(text)
        os.chmod(p, 0o600)
        if p.stat().st_size > PERSIST_CAP:
            tail = p.read_bytes()[-PERSIST_CAP:]
            tmp = p.with_suffix(".log.tmp")
            tmp.write_bytes(tail)
            os.chmod(tmp, 0o600)
            tmp.replace(p)
    except OSError:
        pass  # persistence is best-effort; never break the live PTY


def load_tail(session_key: str, limit: int = MAX_BUFFER) -> str:
    try:
        data = persist_log_path(session_key).read_bytes()
    except (FileNotFoundError, OSError):
        return ""
    return data[-limit:].decode("utf-8", "replace")


def read_meta(session_key: str) -> dict:
    try:
        return json.loads(persist_meta_path(session_key).read_text())
    except (FileNotFoundError, ValueError, OSError):
        return {}


def write_meta(session_key: str, **fields) -> dict:
    meta = read_meta(session_key)
    meta.update(fields)
    d = persist_dir(session_key)
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    p = persist_meta_path(session_key)
    try:
        tmp = p.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(meta))
        os.chmod(tmp, 0o600)
        tmp.replace(p)
    except OSError:
        pass
    return meta


def is_persist_enabled(session_key: str) -> bool:
    return bool(read_meta(session_key).get("persist", True))


def set_persist(session_key: str, enabled: bool) -> None:
    write_meta(session_key, persist=bool(enabled))
    if not enabled:
        try:
            persist_log_path(session_key).unlink()
        except (FileNotFoundError, OSError):
            pass


def clear_persist(session_key: str) -> None:
    shutil.rmtree(persist_dir(session_key), ignore_errors=True)


def read_cwd(pid: int | None) -> str | None:
    """Linux: the live cwd of the shell via /proc; None elsewhere/on error."""
    if pid is None:
        return None
    try:
        return os.readlink(f"/proc/{pid}/cwd")
    except (OSError, FileNotFoundError):
        return None


def prune_persist(max_idle_days: int = PERSIST_PRUNE_IDLE_DAYS,
                  now: float | None = None) -> int:
    base = _persist_base()
    if not base.exists():
        return 0
    now = now if now is not None else time.time()
    cutoff = now - max_idle_days * 86400
    removed = 0
    for d in base.iterdir():
        if not d.is_dir():
            continue
        try:
            la = json.loads((d / "meta.json").read_text()).get("last_active")
        except (FileNotFoundError, ValueError, OSError):
            la = None
        if la is None:
            try:
                la = d.stat().st_mtime
            except OSError:
                continue
        if la < cutoff:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


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


# --- Gary-drive: per-turn capability hint -----------------------------------
# When Gary-mode is on, each brain turn is prefixed with a note telling the
# agent it can drive THIS chat's attached terminal via the loopback MCP, plus a
# freshly-minted single-chat token. The note is stripped from the history view
# (strip_capability_note) so the user never sees it. The marker is led by an
# invisible separator (U+2063) so it can't collide with normal message content.
_GARY_NOTE_PREFIX = "⁣[terminal-control]"
_ATTACH_NOTE_PREFIX = "⁣[terminal-images]"


def gary_capability_note(session_key: str) -> str:
    token = mint_terminal_token(session_key)
    # IMPORTANT: instruct a DIRECT loopback curl, not `mcporter call`. On this
    # host every mcporter invocation cold-starts Node (seconds), so the agent
    # lagged and then went hunting for the binary (10+ tool calls, ~3 min for a
    # trivial command). curl is one fast shot, no Node spawn.
    return (
        f"{_GARY_NOTE_PREFIX} A shell terminal is attached to THIS chat "
        "(cwd = workspace root); the user watches its output live in their terminal "
        "panel. Run a command in it with ONE curl — do NOT use mcporter, do NOT "
        "search for any binary, do NOT retry; the response body IS the command "
        "output:\n"
        "  curl -sS http://127.0.0.1:8800/api/terminal/mcp/run "
        "-H 'content-type: application/json' "
        f'-d \'{{"token":"{token}","command":"<your command>"}}\'\n'
        "It returns JSON {output, exited, exit_code}. For interactive input use "
        f'.../api/terminal/mcp/write with {{"token":"{token}","data":"<keys>"}}. '
        "A 403 means terminal control is off for this chat. Prefer this over your "
        "own bash whenever the user refers to 'the terminal'.\n\n"
    )


def terminal_attachment_note(session_key: str) -> str:
    """A per-turn, history-stripped note mapping the chat's terminal image
    tokens to their on-disk paths, so Gary can resolve a [name.ext] he sees in
    chat text or terminal output. Empty when the chat has no terminal images."""
    items = list_attachments(session_key)
    if not items:
        return ""
    lines = "\n".join(f"  {it['token']} → {it['path']}" for it in items)
    return (
        f"{_ATTACH_NOTE_PREFIX} Images the user dropped into THIS chat's terminal "
        "are saved as files. A [name.ext] token in the terminal or chat refers to:\n"
        f"{lines}\n\n"
    )


def strip_capability_note(text: str) -> str:
    """Remove injected per-turn context blocks (terminal-control and/or
    terminal-images) from a stored message for display. Anchored at the start —
    the notes are always *prepended* — and looped so multiple stacked blocks are
    all removed. Each block runs from its marker to the first blank line."""
    if not isinstance(text, str):
        return text
    while text.startswith(_GARY_NOTE_PREFIX) or text.startswith(_ATTACH_NOTE_PREFIX):
        end = text.find("\n\n")
        text = text[end + 2:] if end != -1 else ""
    return text


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


@router.get("/api/terminal/gary-mode")
async def terminal_gary_mode_get(request: Request, session_key: str = ""):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    from . import sessions_store
    override = sessions_store.gary_terminal_override(session_key) if session_key else None
    return {
        "global_default": gary_mode_default(),
        "override": override,                       # None | bool
        "effective": gary_mode_for_session(session_key) if session_key else gary_mode_default(),
    }


@router.post("/api/terminal/gary-mode")
async def terminal_gary_mode_set(request: Request):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    from . import sessions_store
    body = await request.json()
    scope = body.get("scope")
    enabled = body.get("enabled")   # bool, or None to clear a session override (inherit)
    session_key = str(body.get("session_key", ""))
    if scope == "global":
        from . import websearch
        websearch.save_settings({"gary_terminal_default": bool(enabled)})
    elif scope == "session":
        sid = sessions_store.id_for_session_key(session_key)
        if not sid:
            raise HTTPException(status_code=404, detail="unknown session")
        sessions_store.set_gary_terminal(sid, enabled if enabled is None else bool(enabled))
    else:
        raise HTTPException(status_code=400, detail="scope must be 'session' or 'global'")
    return {
        "global_default": gary_mode_default(),
        "override": (sessions_store.gary_terminal_override(session_key) if session_key else None),
        "effective": gary_mode_for_session(session_key) if session_key else gary_mode_default(),
    }


@router.post("/api/terminal/{session_key}/close")
async def terminal_close(session_key: str, request: Request):
    client_host = request.client.host if request.client else None
    if not terminal_access_allowed(client_host, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    close_session(session_key)
    return {"ok": True}


@router.post("/api/terminal/{session_key}/attach")
async def terminal_attach(session_key: str, request: Request):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    body = await request.json()
    file_id = str(body.get("file_id", ""))
    if not file_id:
        raise HTTPException(status_code=400, detail="file_id required")
    try:
        token = register_attachment(session_key, file_id,
                                    name=body.get("name"), mime=body.get("mime"))
    except ValueError:
        raise HTTPException(status_code=400, detail="invalid file_id")
    return {"token": token}


@router.get("/api/terminal/{session_key}/attachments")
async def terminal_attachments(session_key: str, request: Request, pending: int = 0):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    return {"attachments": list_attachments(session_key, pending_only=bool(pending))}


@router.get("/api/terminal/{session_key}/resolve")
async def terminal_resolve(session_key: str, request: Request, token: str = ""):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    path = resolve_attachment(session_key, token)
    if not path:
        raise HTTPException(status_code=404, detail="unknown token")
    return {"path": path}


# --- Gary-drive: loopback MCP-facing endpoints ------------------------------
async def _await_shell_quiescent(sess, cap=6.0, settle=0.4):
    """Wait until the shell has emitted output (its prompt) AND gone quiet, so a
    command written next isn't sent to a not-yet-ready interactive shell. A
    freshly spawned `zsh -i`/`bash -i` takes a beat to print its first prompt;
    writing before then gets the command echoed-but-not-run (its output lost) and
    can wedge the line editor for the next command. For an already-idle warm shell
    this returns in ~`settle`s. Returns when settled or `cap` elapses."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + cap
    while loop.time() < deadline and sess.total_written == 0:
        await asyncio.sleep(0.05)  # wait for the first prompt to appear
    last = sess.total_written
    quiet_until = loop.time() + settle
    while loop.time() < deadline:
        await asyncio.sleep(0.05)
        if sess.total_written != last:
            last = sess.total_written
            quiet_until = loop.time() + settle
        elif loop.time() >= quiet_until:
            break


async def _await_settled_output(sess, cursor, settle=1.2, cap=20.0):
    """Poll until total_written stops growing for `settle`s or `cap` elapses;
    return the chars appended since `cursor` (a prior total_written value),
    clamped to what's still in the rotated buffer."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + cap
    last = sess.total_written
    quiet_until = loop.time() + settle
    while loop.time() < deadline:
        await asyncio.sleep(0.1)
        if sess.total_written != last:
            last = sess.total_written
            quiet_until = loop.time() + settle
        elif loop.time() >= quiet_until:
            break
    new_chars = sess.total_written - cursor
    if new_chars <= 0:
        return ""
    return sess.buffer[-new_chars:] if new_chars <= len(sess.buffer) else sess.buffer


@router.post("/api/terminal/mcp/run")
async def terminal_mcp_run(request: Request):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    body = await request.json()
    session_key = resolve_terminal_token(str(body.get("token", "")))
    if not session_key:
        raise HTTPException(status_code=404, detail="invalid or expired terminal token")
    if not gary_mode_for_session(session_key):
        raise HTTPException(status_code=403, detail="Gary terminal control is off for this chat")
    sess = get_or_create(session_key)
    sess.attach_reader(asyncio.get_running_loop())
    # Wait for the shell to be ready & quiescent BEFORE writing, or a freshly
    # spawned interactive shell echoes the command without running it (output
    # lost) and wedges the next command. Cheap (~settle) for a warm shell.
    await _await_shell_quiescent(sess)
    cursor = sess.total_written
    sess.write(str(body.get("command", "")) + "\n")
    output = await _await_settled_output(sess, cursor, cap=float(body.get("timeout", 20)))
    return {"output": output, "exited": sess.exited, "exit_code": sess.exit_code}


@router.post("/api/terminal/mcp/read")
async def terminal_mcp_read(request: Request):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    body = await request.json()
    session_key = resolve_terminal_token(str(body.get("token", "")))
    if not session_key:
        raise HTTPException(status_code=404, detail="invalid or expired terminal token")
    sess = _sessions.get(session_key)
    tail = int(body.get("tail", 4000))
    return {"output": (sess.buffer[-tail:] if sess else ""), "running": bool(sess and not sess.exited)}


@router.post("/api/terminal/mcp/write")
async def terminal_mcp_write(request: Request):
    if not terminal_access_allowed(request.client.host if request.client else None, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
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
