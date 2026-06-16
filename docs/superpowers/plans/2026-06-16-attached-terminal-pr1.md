# Attached Terminal — PR1 (human-interactive) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a right-side terminal panel, attached to the active chat, with a real interactive PTY (cwd = workspace root) that the user types into directly — reachable only through the tailnet front door.

**Architecture:** A new FastAPI router (`backend/terminals.py`) owns an in-memory `session_key → PtySession` registry. Each `PtySession` wraps a stdlib `pty.fork()` shell, keeps a capped scrollback buffer, and fans output to subscriber queues. A guarded WebSocket (`/api/terminal/{session_key}/stream`) streams bytes both ways. A self-contained frontend overlay (`frontend-overrides/js/workspace-terminal.js`, mirroring `workspace-explorer.js`) injects its own rail button + resizable `<aside>`, lazily loads vendored xterm.js, and follows the active chat session.

**Tech Stack:** Python 3 / FastAPI / Starlette WebSockets / stdlib `pty`,`fcntl`,`termios`; vendored `@xterm/xterm` 5.5.0 + `@xterm/addon-fit` 0.10.0; plain-JS IIFE overlay.

**Spec:** `docs/superpowers/specs/2026-06-16-attached-terminal-design.md`

---

## Scope (PR1 only)

Implements spec §1 (PtySession), §2 (guarded WS), §3 (panel). **Spec §4 (Gary-mode state) is intentionally deferred to the PR2 plan**, because the toggle's only consumer is the Gary write-gate, which does not exist until PR2's MCP path — shipping an inert toggle now is YAGNI. PR1's deliverable is a working human terminal. §5/§6 (MCP, bridge hint) are PR2 by the spec's own phasing.

## File structure

- **Create** `backend/terminals.py` — PtySession, registry, access guard, WS + close routes. One responsibility: the terminal backend.
- **Modify** `backend/app.py` — import + `include_router` (2 lines), mirroring the other routers.
- **Create** `backend/tests/test_terminals.py` — PtySession + guard + registry unit tests.
- **Create** `frontend-overrides/js/vendor/xterm/{xterm.js,xterm.css,addon-fit.js}` — vendored third-party (served at `/static/js/vendor/xterm/`).
- **Create** `frontend-overrides/js/workspace-terminal.js` — self-contained panel overlay.
- **Modify** `frontend-overrides/index.html` — one `<script>` include (1 line).
- **Modify** `frontend-overrides/workspace.css` — terminal panel styles.

All test commands run from the repo root `/Users/admin/openclaw-workspace` using the project venv: `.venv/bin/pytest`.

---

### Task 1: PtySession, registry, and access guard

**Files:**
- Create: `backend/terminals.py`
- Test: `backend/tests/test_terminals.py`

- [ ] **Step 1: Write the failing tests**

Create `backend/tests/test_terminals.py`:

```python
"""Attached-terminal backend: PTY lifecycle, scrollback cap, and the
loopback+Serve-identity access guard. PR1 (human-interactive)."""
import time

import pytest

from backend import terminals


def _spin(sess, needle, tries=80):
    """PTY output is async; poll drain_once() until the needle shows up."""
    for _ in range(tries):
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


def test_guard_rejects_non_loopback():
    assert terminals.terminal_access_allowed(
        "192.168.1.20", {"tailscale-user-login": "frank@example.com"}
    ) is False


def test_guard_rejects_loopback_without_header():
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is False


def test_guard_allows_loopback_with_header():
    assert terminals.terminal_access_allowed(
        "127.0.0.1", {"tailscale-user-login": "frank@example.com"}
    ) is True


def test_guard_header_override_relaxes_to_loopback_only(monkeypatch):
    monkeypatch.setenv("OPENCLAW_TERMINAL_REQUIRE_TSHEADER", "0")
    assert terminals.terminal_access_allowed("127.0.0.1", {}) is True


def test_get_or_create_reuses_live_session():
    a = terminals.get_or_create("reuse-key")
    b = terminals.get_or_create("reuse-key")
    try:
        assert a is b
    finally:
        terminals.close_session("reuse-key")
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `.venv/bin/pytest backend/tests/test_terminals.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'backend.terminals'`.

- [ ] **Step 3: Write the minimal implementation**

Create `backend/terminals.py`:

```python
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

    def _mark_exited(self) -> None:
        if self.exited:
            return
        self.exited = True
        try:
            if self.pid:
                _, status = os.waitpid(self.pid, os.WNOHANG)
                self.exit_code = os.waitstatus_to_exitcode(status) if status else 0
        except (ChildProcessError, OSError):
            self.exit_code = self.exit_code if self.exit_code is not None else 0

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
        if self.pid:
            try:
                os.kill(self.pid, signal.SIGHUP)
            except ProcessLookupError:
                pass
        self._mark_exited()
        self._detach_reader()
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `.venv/bin/pytest backend/tests/test_terminals.py -q`
Expected: PASS (9 passed).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminals.py
git commit -m "feat(terminal): PtySession, registry, and loopback+Serve access guard"
```

---

### Task 2: Guarded WebSocket + close route, registered in the app

**Files:**
- Modify: `backend/terminals.py` (append routes)
- Modify: `backend/app.py` (import + include_router)

- [ ] **Step 1: Add the WS + close routes**

Append to `backend/terminals.py`:

```python
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
        while True:
            kind, payload = await queue.get()
            if kind == "output":
                await websocket.send_json({"type": "output", "data": payload})
            elif kind == "exit":
                await websocket.send_json({"type": "exit", "code": payload})

    out_task = asyncio.create_task(pump_out())
    try:
        while True:
            msg = await websocket.receive_json()
            mtype = msg.get("type")
            if mtype == "input":
                sess.write(msg.get("data", ""))
            elif mtype == "resize":
                sess.resize(int(msg.get("cols", DEFAULT_COLS)), int(msg.get("rows", DEFAULT_ROWS)))
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        out_task.cancel()
        sess.unsubscribe(queue)


@router.post("/api/terminal/{session_key}/close")
async def terminal_close(session_key: str, request: Request):
    client_host = request.client.host if request.client else None
    if not terminal_access_allowed(client_host, request.headers):
        raise HTTPException(status_code=403, detail="forbidden")
    close_session(session_key)
    return {"ok": True}
```

- [ ] **Step 2: Register the router in `backend/app.py`**

In `backend/app.py`, add the import alongside the other `router as` imports (next to `from .workspace_files import router as workspace_files_router`):

```python
from .terminals import router as terminals_router
```

And add the include alongside the other `app.include_router(...)` calls (next to `app.include_router(workspace_files_router)`):

```python
app.include_router(terminals_router)
```

- [ ] **Step 3: Verify the app imports cleanly**

Run: `.venv/bin/python -c "from backend.app import app; print('routes', any('/api/terminal' in getattr(r,'path','') for r in app.routes))"`
Expected: prints `routes True`.

- [ ] **Step 4: Re-run the backend tests**

Run: `.venv/bin/pytest backend/tests/test_terminals.py -q`
Expected: PASS (still 9 passed — routes don't break the unit tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/app.py
git commit -m "feat(terminal): guarded WebSocket stream + close route, wired into app"
```

---

### Task 3: Vendor xterm.js

**Files:**
- Create: `frontend-overrides/js/vendor/xterm/xterm.js`
- Create: `frontend-overrides/js/vendor/xterm/xterm.css`
- Create: `frontend-overrides/js/vendor/xterm/addon-fit.js`

- [ ] **Step 1: Fetch the pinned UMD builds into the vendor dir**

```bash
cd /Users/admin/openclaw-workspace
mkdir -p frontend-overrides/js/vendor/xterm
curl -fsSL https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js      -o frontend-overrides/js/vendor/xterm/xterm.js
curl -fsSL https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css     -o frontend-overrides/js/vendor/xterm/xterm.css
curl -fsSL https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js -o frontend-overrides/js/vendor/xterm/addon-fit.js
```

- [ ] **Step 2: Verify the files downloaded and expose the expected globals**

```bash
cd /Users/admin/openclaw-workspace
ls -l frontend-overrides/js/vendor/xterm/
grep -c "Terminal" frontend-overrides/js/vendor/xterm/xterm.js | head -1
grep -c "FitAddon" frontend-overrides/js/vendor/xterm/addon-fit.js | head -1
```
Expected: three non-empty files; both `grep -c` print a number > 0 (the UMD builds set `window.Terminal` and `window.FitAddon`).

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/vendor/xterm/
git commit -m "chore(terminal): vendor @xterm/xterm 5.5.0 + addon-fit 0.10.0 (UMD)"
```

---

### Task 4: The terminal panel overlay

**Files:**
- Create: `frontend-overrides/js/workspace-terminal.js`

> No JS unit harness exists for these overlays (the explorer has none either), so the gate here is `node --check` for syntax + the manual smoke in Task 6.

- [ ] **Step 1: Write `frontend-overrides/js/workspace-terminal.js`**

```javascript
// HERMES: attached terminal panel — a right-side resizable pane (mirrors the
// workspace-explorer pane) holding a real interactive PTY for the ACTIVE chat
// session, streamed over a loopback + Serve-guarded WebSocket. cwd = workspace
// root. Self-contained overlay: injects its own rail button + panel DOM and
// lazily loads vendored xterm.js. Tolerant of a backend without /api/terminal
// (the WS fails to open; the pane shows a notice). PR1 = human-interactive only.
// Spec: docs/superpowers/specs/2026-06-16-attached-terminal-design.md
(function () {
  const LS_WIDTH = 'hermes-terminal-width';
  const VENDOR = '/static/js/vendor/xterm/';
  let term = null, fit = null, ws = null, sessionKey = null, followTimer = null;

  function curSession() {
    try {
      return (window.sessionModule && window.sessionModule.getCurrentSessionId)
        ? window.sessionModule.getCurrentSessionId() : null;
    } catch (e) { return null; }
  }

  function injectCss(href) {
    if (document.querySelector('link[data-wt-css]')) return;
    const l = document.createElement('link');
    l.rel = 'stylesheet'; l.href = href; l.setAttribute('data-wt-css', '1');
    document.head.appendChild(l);
  }
  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('load ' + src));
      document.head.appendChild(s);
    });
  }
  async function ensureXterm() {
    injectCss(VENDOR + 'xterm.css');
    if (!window.Terminal) await injectScript(VENDOR + 'xterm.js');
    if (!window.FitAddon) await injectScript(VENDOR + 'addon-fit.js');
  }

  function buildDom() {
    if (document.getElementById('workspace-terminal')) return;
    const rail = document.getElementById('icon-rail');
    if (rail && !document.getElementById('rail-terminal')) {
      const b = document.createElement('button');
      b.className = 'icon-rail-btn'; b.id = 'rail-terminal'; b.title = 'Terminal';
      b.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" '
        + 'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
        + 'stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/>'
        + '<line x1="12" y1="19" x2="20" y2="19"/></svg>';
      b.addEventListener('click', toggle);
      rail.appendChild(b);
    }
    const aside = document.createElement('aside');
    aside.id = 'workspace-terminal'; aside.hidden = true;
    aside.setAttribute('aria-label', 'Attached terminal');
    aside.innerHTML =
      '<div class="wt-resize" id="wt-resize"></div>' +
      '<header class="wt-head">' +
        '<span class="wt-title">Terminal</span>' +
        '<span class="wt-cwd" id="wt-cwd"></span>' +
        '<span class="wt-spacer"></span>' +
        '<button class="wt-btn" id="wt-restart" title="Restart shell">↻</button>' +
        '<button class="wt-btn" id="wt-close" title="Close panel">✕</button>' +
      '</header>' +
      '<div class="wt-screen" id="wt-screen"></div>' +
      '<div class="wt-status" id="wt-status" hidden></div>';
    document.body.appendChild(aside);
    const w = parseInt(localStorage.getItem(LS_WIDTH) || '', 10);
    if (w > 360 && w < 1100) aside.style.width = w + 'px';
    document.getElementById('wt-close').addEventListener('click', hide);
    document.getElementById('wt-restart').addEventListener('click', restart);
    wireResize(aside);
  }

  function wsUrl(key) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return proto + '://' + location.host + '/api/terminal/' + encodeURIComponent(key) + '/stream';
  }
  function status(msg) {
    const s = document.getElementById('wt-status');
    if (!s) return;
    s.textContent = msg || ''; s.hidden = !msg;
  }
  function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function disconnect() {
    if (ws) { try { ws.onclose = null; ws.close(); } catch (e) {} ws = null; }
  }
  function connect(key) {
    disconnect();
    sessionKey = key;
    status('');
    try { ws = new WebSocket(wsUrl(key)); } catch (e) { status('terminal unavailable'); return; }
    ws.onopen = () => { status(''); fitAndResize(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.type === 'output') term.write(m.data);
      else if (m.type === 'exit') {
        term.write('\r\n\x1b[2m[process exited'
          + (m.code != null ? ' (' + m.code + ')' : '') + '] — press ↻ to restart\x1b[0m\r\n');
      }
    };
    ws.onclose = () => { if (sessionKey === key) status('disconnected — reopen to reconnect'); };
    ws.onerror = () => status('terminal backend unavailable');
  }

  function fitAndResize() {
    if (!fit || !term) return;
    try { fit.fit(); } catch (e) {}
    send({ type: 'resize', cols: term.cols, rows: term.rows });
  }

  async function open() {
    buildDom();
    try { await ensureXterm(); } catch (e) { status('failed to load terminal assets'); show(); return; }
    if (!term) {
      term = new window.Terminal({
        cursorBlink: true, fontSize: 13,
        fontFamily: 'ui-monospace, Menlo, Monaco, monospace',
        theme: { background: '#0b0e14' },
      });
      fit = new window.FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById('wt-screen'));
      term.onData((d) => send({ type: 'input', data: d }));
    }
    if (!window.__workspaceRoot) {
      fetch('/api/config').then((r) => r.json()).then((c) => {
        window.__workspaceRoot = c.workspace_root;
        const el = document.getElementById('wt-cwd');
        if (el) el.textContent = c.workspace_root || '';
      }).catch(() => {});
    } else {
      const el = document.getElementById('wt-cwd');
      if (el) el.textContent = window.__workspaceRoot;
    }
    show();
    connect(curSession() || 'global');
    setTimeout(fitAndResize, 40);
    startFollow();
  }

  function show() {
    const a = document.getElementById('workspace-terminal');
    if (a) a.hidden = false;
    document.getElementById('rail-terminal')?.classList.add('active');
  }
  function hide() {
    const a = document.getElementById('workspace-terminal');
    if (a) a.hidden = true;
    document.getElementById('rail-terminal')?.classList.remove('active');
    stopFollow();
    disconnect();
  }
  function toggle() {
    const a = document.getElementById('workspace-terminal');
    if (!a || a.hidden) open(); else hide();
  }
  function restart() {
    if (!sessionKey) return;
    const key = sessionKey;
    fetch('/api/terminal/' + encodeURIComponent(key) + '/close', { method: 'POST' })
      .catch(() => {})
      .finally(() => { if (term) term.reset(); connect(key); setTimeout(fitAndResize, 40); });
  }

  // Follow the active chat: while the panel is open, reconnect if the user
  // switches chats (cheap 1.2s poll, only while visible).
  function startFollow() {
    stopFollow();
    followTimer = setInterval(() => {
      const a = document.getElementById('workspace-terminal');
      if (!a || a.hidden) return;
      const key = curSession() || 'global';
      if (key !== sessionKey) { if (term) term.reset(); connect(key); setTimeout(fitAndResize, 40); }
    }, 1200);
  }
  function stopFollow() { if (followTimer) { clearInterval(followTimer); followTimer = null; } }

  function wireResize(aside) {
    const h = aside.querySelector('#wt-resize');
    if (!h) return;
    let startX = 0, startW = 0, dragging = false;
    h.addEventListener('mousedown', (e) => {
      dragging = true; startX = e.clientX;
      startW = aside.getBoundingClientRect().width;
      e.preventDefault(); document.body.style.userSelect = 'none';
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      let w = startW + (startX - e.clientX);
      w = Math.max(360, Math.min(1100, w));
      aside.style.width = w + 'px';
      if (fit) { try { fit.fit(); } catch (_) {} }
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false; document.body.style.userSelect = '';
      try { localStorage.setItem(LS_WIDTH, String(Math.round(aside.getBoundingClientRect().width))); } catch (_) {}
      fitAndResize();
    });
  }

  window.workspaceTerminal = { open, hide, toggle };
  // Inject the rail button early so the user can launch the panel without it
  // having been opened first.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildDom, { once: true });
  else buildDom();
})();
```

- [ ] **Step 2: Syntax-check**

Run: `node --check frontend-overrides/js/workspace-terminal.js`
Expected: no output, exit 0.

- [ ] **Step 3: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/workspace-terminal.js
git commit -m "feat(terminal): self-contained xterm panel overlay following the active chat"
```

---

### Task 5: Wire the script include + panel styles

**Files:**
- Modify: `frontend-overrides/index.html`
- Modify: `frontend-overrides/workspace.css`

- [ ] **Step 1: Add the script include**

In `frontend-overrides/index.html`, find the existing line:

```html
  <script src="/static/js/workspace-explorer.js" defer></script>
```

Add immediately after it:

```html
  <script src="/static/js/workspace-terminal.js" defer></script>
```

- [ ] **Step 2: Add panel styles**

Append to `frontend-overrides/workspace.css`:

```css
/* Attached terminal panel — right-side resizable pane (mirrors #workspace-explorer). */
#workspace-terminal {
  position: fixed; top: 0; right: 0; height: 100vh; width: 560px;
  display: flex; flex-direction: column;
  background: #0b0e14; color: #cdd6f4;
  border-left: 1px solid var(--border, #2a2f3a);
  z-index: 60; box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
}
#workspace-terminal[hidden] { display: none; }
#workspace-terminal .wt-resize {
  position: absolute; left: 0; top: 0; width: 6px; height: 100%; cursor: col-resize;
}
#workspace-terminal .wt-head {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 10px; font-size: 12px; border-bottom: 1px solid #2a2f3a;
}
#workspace-terminal .wt-title { font-weight: 600; }
#workspace-terminal .wt-cwd {
  opacity: 0.6; font-family: ui-monospace, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 280px;
}
#workspace-terminal .wt-spacer { flex: 1; }
#workspace-terminal .wt-btn {
  background: none; border: none; color: inherit; cursor: pointer;
  font-size: 13px; padding: 2px 6px; border-radius: 4px;
}
#workspace-terminal .wt-btn:hover { background: rgba(255, 255, 255, 0.08); }
#workspace-terminal .wt-screen { flex: 1; min-height: 0; padding: 4px 6px; }
#workspace-terminal .wt-status { padding: 4px 10px; font-size: 12px; color: #f38ba8; }
@media (max-width: 720px) {
  #workspace-terminal { width: 100vw !important; }
}
```

- [ ] **Step 3: Verify the edits landed**

```bash
cd /Users/admin/openclaw-workspace
grep -n "workspace-terminal.js" frontend-overrides/index.html
grep -n "#workspace-terminal {" frontend-overrides/workspace.css
```
Expected: one match each.

- [ ] **Step 4: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/index.html frontend-overrides/workspace.css
git commit -m "feat(terminal): include panel script + right-pane styles"
```

---

### Task 6: Manual smoke (backend guard + live panel)

> Backend changes require a workspace restart to load the new router. The restart is **user-gated** (2014 Mac mini, 8GB — cold boots are slow; never restart repeatedly). Ask the user to restart, or run the project's restart script if they OK it.

- [ ] **Step 1: Restart the workspace backend (user-gated)**

Ask the user to restart the workspace so the new router loads (e.g. the LaunchAgent / `scripts/` restart they normally use). Do not loop on restarts.

- [ ] **Step 2: Prove the guard rejects loopback WITHOUT the Serve header**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  "http://127.0.0.1:8800/api/terminal/smoke/stream"
```
Expected: `403` (loopback but no `Tailscale-User-Login` header ⇒ refused).

- [ ] **Step 3: Prove the guard accepts loopback WITH the header**

```bash
curl -sS -o /dev/null -w "%{http_code}\n" \
  -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" -H "Sec-WebSocket-Version: 13" \
  -H "Tailscale-User-Login: smoke@test" \
  "http://127.0.0.1:8800/api/terminal/smoke/stream"
```
Expected: `101` (Switching Protocols — handshake accepted).

- [ ] **Step 4: Confirm Serve injects the header on the 8443 path (lockout safeguard)**

Ask the user to open the workspace on `https://bespin…ts.net:8443`, click the new **Terminal** rail button, and confirm a shell prompt appears and typing works. If it connects: Serve is injecting `Tailscale-User-Login` — done. If it shows "terminal backend unavailable" / disconnects: the header is NOT arriving through Serve; set `OPENCLAW_TERMINAL_REQUIRE_TSHEADER=0` in the workspace env (loopback-only floor still holds) and file a follow-up to recover identity. Report which path occurred.

- [ ] **Step 5: Eyeball checklist (user, on the 8443 origin)**

Confirm: shell opens at the workspace root (run `pwd`); `printf hi` echoes; an interactive program works (`top`, `q` to quit); resizing the panel reflows the shell; switching to another chat re-attaches to a different terminal; reopening the panel replays prior scrollback; `↻` restarts the shell.

- [ ] **Step 6: Commit (docs/notes only, if any smoke notes were added)**

No code commit expected here unless smoke surfaces a fix; if it does, fix → re-run Tasks 1–5 verification → commit with a `fix(terminal): …` message.

---

## Self-review

- **Spec coverage:** §1 PtySession → Task 1; §2 guarded WS → Tasks 1 (guard) + 2 (WS); §3 panel (xterm, right pane, same-origin wss, auto-reconnect/replay, follow active chat) → Tasks 3–5; loopback + Serve-header guard with lockout safeguard → Task 1 + Task 6 steps 2–4; "no headless Chrome" testing → unit tests + curl + user eyeball. §4 Gary-mode explicitly deferred to PR2 (noted in Scope). §5/§6 are PR2.
- **Placeholders:** none — every step has concrete code/commands and expected output.
- **Type/name consistency:** `PtySession`, `terminal_access_allowed`, `get_or_create`, `close_session`, `drain_once`, `attach_reader`, `subscribe`/`unsubscribe`, message types `input`/`resize`/`output`/`exit`, ids `workspace-terminal`/`wt-screen`/`rail-terminal`, env `OPENCLAW_TERMINAL_REQUIRE_TSHEADER`, localStorage `hermes-terminal-width` — all used identically across backend, frontend, and tests.
