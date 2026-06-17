# Terminal Scrollback Persistence (Tier A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A chat's terminal contents (scrollback) and working directory survive reboots; reopening replays the saved output and starts a fresh shell in the same directory.

**Architecture:** Extend `backend/terminals.py`. Add a per-session on-disk store (`terminals/<key>/scrollback.log` + `meta.json`) that the always-on PTY reader appends to on a batched flush. The in-RAM `self.buffer` becomes a tail cache seeded from disk on (re)create; restore seeds `sess.buffer` (which the WS handler already replays on connect) plus a dim separator, and spawns the shell in the saved cwd. Frontend gains an incognito toggle + clear-history on the kill button.

**Tech Stack:** Python stdlib only (`re`, `os`, `json`, `shutil`, `time`, `pathlib`), FastAPI `APIRouter` (existing), pytest; vanilla JS frontend (no build step).

## Global Constraints

- **Backend store functions resolve `config.DATA_DIR` at CALL TIME** (like the existing `_attachments_dir()`), so the autouse conftest fixture (`monkeypatch.setattr(config, "DATA_DIR", tmp_path/"data")`) isolates every test. Never cache `DATA_DIR` at import.
- **Persist terminal OUTPUT only — never log keystrokes/input.** (No-echo password prompts never enter the output stream.)
- **Files mode `0o600`, directories mode `0o700`.**
- **Batched flush only — never per-keystroke disk writes.** Flush when ≥ `PERSIST_FLUSH_INTERVAL = 1.0` s since last flush OR pending ≥ `PERSIST_FLUSH_BYTES = 65536`, whichever first; force-flush on session close/exit. (The host has an EMFILE/I-O-stall history.)
- **Rolling cap `PERSIST_CAP = 1_000_000` bytes** per `scrollback.log`.
- **cwd capture: Linux `os.readlink('/proc/<pid>/cwd')` only; return `None` elsewhere** (macOS interim → restore falls back to workspace root). Abstract behind `read_cwd(pid)` so it's testable without `/proc`.
- **Scrubber masks well-known token shapes → `***REDACTED***`** before any disk write: `ghp_`/`gho_`/`ghs_`/`ghr_`/`github_pat_…`, `sk-…`, AWS `AKIA…`, JWTs, PEM `PRIVATE KEY` blocks. Defense-in-depth, NOT a guarantee.
- **Retention:** prune session dirs idle > 30 days (on startup + at most once/24 h via a gate); delete immediately on clear-history / chat-deletion; **do NOT** delete on normal panel close (close must preserve the log for restore).
- **No new dependencies.**
- **This is a BACKEND change → deploying requires a workspace restart** (`launchctl bootout`+`bootstrap`, retry once on "5: I/O error"). Unit tests must never touch the live `.data/` store (the autouse fixture guarantees this).
- pytest invocation: `.venv/bin/python -m pytest <path> -v`.

---

### Task 1: Persistence store + secret scrubber

**Files:**
- Modify: `backend/terminals.py` (add a new section after the attachments block; add module constants near `MAX_BUFFER` at line 29)
- Test: `backend/tests/test_terminal_persistence.py` (new)

**Interfaces:**
- Produces (all take `session_key: str`, resolve `config.DATA_DIR` at call time):
  - `scrub(text: str) -> str`
  - `persist_dir(session_key) -> Path` (creates dir `0o700`)
  - `persist_log_path(session_key) -> Path`, `persist_meta_path(session_key) -> Path`
  - `append_output(session_key, text: str) -> None` (scrubs, appends `0o600`, enforces `PERSIST_CAP`)
  - `load_tail(session_key, limit: int = MAX_BUFFER) -> str`
  - `read_meta(session_key) -> dict`, `write_meta(session_key, **fields) -> dict`
  - `is_persist_enabled(session_key) -> bool` (default `True`), `set_persist(session_key, enabled: bool) -> None`
  - `clear_persist(session_key) -> None`
  - `read_cwd(pid: int | None) -> str | None`
  - `prune_persist(max_idle_days: int = 30, now: float | None = None) -> int` (returns # removed)
  - Constants: `PERSIST_DIRNAME = "terminals"`, `PERSIST_CAP`, `PERSIST_FLUSH_INTERVAL`, `PERSIST_FLUSH_BYTES`

- [ ] **Step 1: Write the failing test**

```python
# backend/tests/test_terminal_persistence.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -v`
Expected: FAIL — `AttributeError: module 'backend.terminals' has no attribute 'scrub'` (and friends).

- [ ] **Step 3: Add constants near `MAX_BUFFER` (line 29)**

```python
MAX_BUFFER = 120_000

# --- Scrollback persistence (Tier A) tunables ---
PERSIST_DIRNAME = "terminals"
PERSIST_CAP = 1_000_000          # rolling per-session scrollback.log byte cap
PERSIST_FLUSH_INTERVAL = 1.0     # seconds; batched flush, never per-keystroke
PERSIST_FLUSH_BYTES = 65536      # or flush once this many bytes pend
PERSIST_PRUNE_IDLE_DAYS = 30
```

- [ ] **Step 4: Add `re`/`shutil` imports and the store section**

Add `import re` and `import shutil` to the import block (top of file, alphabetical with the existing stdlib imports). Then append this section AFTER the terminal-image attachments block (after `mark_consumed`/the attachments helpers, before the `gary_mode_*` functions):

```python
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
    d = _persist_base() / _sanitize_key(session_key)
    d.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(d, 0o700)
    except OSError:
        pass
    return d


def persist_log_path(session_key: str) -> Path:
    return persist_dir(session_key) / "scrollback.log"


def persist_meta_path(session_key: str) -> Path:
    return persist_dir(session_key) / "meta.json"


def append_output(session_key: str, text: str) -> None:
    """Scrub then append OUTPUT to the rolling log (0o600), capped at PERSIST_CAP."""
    if not text:
        return
    text = scrub(text)
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -v`
Expected: PASS — 8 tests pass, output pristine.

- [ ] **Step 6: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminal_persistence.py
git commit -m "feat(terminal): on-disk scrollback persistence store + secret scrubber"
```

---

### Task 2: PtySession integration — batched flush + persist flag

**Files:**
- Modify: `backend/terminals.py` — `PtySession.__init__` (lines 63-74), `_on_readable` (lines 207-215), `close` (lines 171-198)
- Test: `backend/tests/test_terminal_persistence.py` (append)

**Interfaces:**
- Consumes: the Task 1 store functions.
- Produces: `PtySession` gains attributes `self.persist: bool`, `self._persist_pending: str`, `self._persist_last_flush: float`, and method `flush_persist(self, force: bool = False) -> None`. `flush_persist` appends pending output (when gated/forced) and updates `meta.json` (`last_active`, `last_cwd`, `cols`, `rows`, `persist`).

- [ ] **Step 1: Write the failing test (append to the test file)**

```python
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -k "flush or incognito or gated" -v`
Expected: FAIL — `AttributeError: 'PtySession' object has no attribute 'flush_persist'`.

- [ ] **Step 3: Extend `__init__` (after line 74, the `_reader_loop` line)**

```python
        self._reader_loop: asyncio.AbstractEventLoop | None = None
        self.persist = is_persist_enabled(session_key)
        self._persist_pending = ""
        self._persist_last_flush = 0.0
```

- [ ] **Step 4: Add `flush_persist` (new method, place right after `_append`, line 105)**

```python
    def flush_persist(self, force: bool = False) -> None:
        """Append batched output to the on-disk log and refresh meta. Gated to
        avoid per-keystroke writes; force=True on close/exit. No-op when the
        session is incognito (persist disabled)."""
        if not self.persist:
            self._persist_pending = ""
            return
        now = time.monotonic()
        ready = (now - self._persist_last_flush >= PERSIST_FLUSH_INTERVAL
                 or len(self._persist_pending) >= PERSIST_FLUSH_BYTES)
        if not force and not ready:
            return
        if self._persist_pending:
            append_output(self.session_key, self._persist_pending)
            self._persist_pending = ""
        last_cwd = read_cwd(self.pid) or read_meta(self.session_key).get("last_cwd")
        write_meta(self.session_key, last_active=time.time(), last_cwd=last_cwd,
                   cols=self.cols, rows=self.rows, persist=self.persist)
        self._persist_last_flush = now
```

- [ ] **Step 5: Hook into `_on_readable` (lines 207-215)**

Replace the method body with:

```python
    def _on_readable(self) -> None:
        text = self.drain_once()
        if text:
            for q in list(self._subscribers):
                q.put_nowait(("output", text))
            if self.persist:
                self._persist_pending += text
                self.flush_persist()
        if self.exited:
            for q in list(self._subscribers):
                q.put_nowait(("exit", self.exit_code))
            self.flush_persist(force=True)
            self._detach_reader()
```

- [ ] **Step 6: Force-flush in `close` (add as the FIRST statement of `close`, line 172)**

```python
    def close(self) -> None:
        # Persist any pending output before tearing the shell down.
        self.flush_persist(force=True)
        # Idempotent: safe to call twice, and safe if start() never set a pid.
        if self.pid is not None:
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -v`
Expected: PASS — all (Task 1 + Task 2) tests pass.

- [ ] **Step 8: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminal_persistence.py
git commit -m "feat(terminal): batched flush + persist flag on PtySession"
```

---

### Task 3: Restore on (re)create + cwd spawn + prune gate

**Files:**
- Modify: `backend/terminals.py` — `start()` (line 80, the `cwd = ...` assignment), `get_or_create` (lines 237-249); add `_restore_cwd`, `_restore_separator`, `_maybe_prune` helpers + a `_last_prune` module global
- Test: `backend/tests/test_terminal_persistence.py` (append)

**Interfaces:**
- Consumes: Task 1 store + `is_persist_enabled`/`read_meta`/`load_tail`/`prune_persist`.
- Produces: `_restore_cwd(session_key) -> str | None`, `_restore_separator(cwd: str | None) -> str`, `_maybe_prune() -> None`. `get_or_create`, on creating a session that has a persisted log, seeds `sess.buffer` with `load_tail(...) + separator` (capped to `MAX_BUFFER`) so the WS handler's on-connect `sess.buffer` replay shows yesterday's contents.

- [ ] **Step 1: Write the failing test (append)**

```python
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -k "restore or seeds" -v`
Expected: FAIL — `AttributeError: ... has no attribute '_restore_cwd'`.

- [ ] **Step 3: Modify `start()` cwd selection (line 80)**

Replace `cwd = str(workspace_files.workspace_root())` with:

```python
        cwd = _restore_cwd(self.session_key) or str(workspace_files.workspace_root())
```

- [ ] **Step 4: Add the helpers + `_last_prune` global (place just before `get_or_create`, line 237)**

```python
_last_prune = 0.0


def _restore_cwd(session_key: str) -> str | None:
    if not is_persist_enabled(session_key):
        return None
    c = read_meta(session_key).get("last_cwd")
    if c and os.path.isdir(c):
        return c
    return None


def _restore_separator(cwd: str | None) -> str:
    when = time.strftime("%Y-%m-%d %H:%M")
    where = cwd or "~"
    return f"\r\n\x1b[2m──── restored {when} · {where} ────\x1b[0m\r\n"


def _maybe_prune() -> None:
    """Prune idle sessions on startup and at most once per 24h per process."""
    global _last_prune
    now = time.time()
    if now - _last_prune < 86400:
        return
    _last_prune = now
    try:
        prune_persist()
    except OSError:
        pass
```

- [ ] **Step 5: Modify `get_or_create` (lines 237-249)**

```python
def get_or_create(session_key: str, *, cols: int = DEFAULT_COLS, rows: int = DEFAULT_ROWS) -> PtySession:
    _maybe_prune()
    sess = _sessions.get(session_key)
    if sess is None or sess.exited:
        restored = load_tail(session_key) if is_persist_enabled(session_key) else ""
        sess = PtySession(session_key, cols=cols, rows=rows)
        sess.start()
        if restored:
            sep = _restore_separator(read_meta(session_key).get("last_cwd"))
            sess.buffer = (restored + sep)[-MAX_BUFFER:]
        _sessions[session_key] = sess
    # Always-on reader: keep `buffer` current even with no WebSocket attached, so
    # Gary's MCP read/run see live output. attach_reader is idempotent.
    try:
        sess.attach_reader(asyncio.get_running_loop())
    except RuntimeError:
        pass  # no running loop (sync unit tests) — WS/endpoints attach later
    return sess
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -v && .venv/bin/python -m pytest backend/tests/test_terminals.py -v`
Expected: PASS — persistence tests pass AND the existing terminal suite still passes (notably `test_pty_cwd_is_workspace_root`, since no saved cwd → workspace root).

- [ ] **Step 7: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminal_persistence.py
git commit -m "feat(terminal): restore scrollback + cwd on reopen; idle prune gate"
```

---

### Task 4: REST endpoints — persist toggle + clear-history

**Files:**
- Modify: `backend/terminals.py` — add two routes near the existing `gary-mode` routes (after line 521 area)
- Test: `backend/tests/test_terminals_mcp.py` is route-style; add a small route test to `backend/tests/test_terminal_persistence.py` using `fastapi.testclient`

**Interfaces:**
- Consumes: `is_persist_enabled`, `set_persist`, `clear_persist`, `_sessions`.
- Produces: `GET /api/terminal/{session_key}/persist` → `{"enabled": bool}`; `POST /api/terminal/{session_key}/persist` body `{"enabled": bool}` → `{"enabled": bool}` (also flips a live session's `.persist`); `POST /api/terminal/{session_key}/clear-history` → `{"ok": true}` (wipes log + live buffer).

- [ ] **Step 1: Write the failing test (append)**

```python
def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    app = FastAPI()
    app.include_router(terminals.router)
    return TestClient(app)


def test_persist_endpoints_roundtrip():
    c = _client()
    key = "ep-key"
    assert c.get(f"/api/terminal/{key}/persist").json() == {"enabled": True}
    assert c.post(f"/api/terminal/{key}/persist", json={"enabled": False}).json() == {"enabled": False}
    assert terminals.is_persist_enabled(key) is False


def test_clear_history_endpoint_wipes_log():
    c = _client()
    key = "ep-clear"
    terminals.append_output(key, "stuff")
    assert c.post(f"/api/terminal/{key}/clear-history").json() == {"ok": True}
    assert terminals.load_tail(key) == ""
```

- [ ] **Step 2: Run to verify it fails**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -k "endpoint or clear_history" -v`
Expected: FAIL — 404 (routes not defined).

- [ ] **Step 3: Add the routes (after the `gary-mode` POST route)**

```python
@router.get("/api/terminal/{session_key}/persist")
async def terminal_persist_get(session_key: str):
    return {"enabled": is_persist_enabled(session_key)}


@router.post("/api/terminal/{session_key}/persist")
async def terminal_persist_set(session_key: str, request: Request):
    body = await request.json()
    enabled = bool(body.get("enabled", True))
    set_persist(session_key, enabled)
    s = _sessions.get(session_key)
    if s is not None:
        s.persist = enabled
    return {"enabled": enabled}


@router.post("/api/terminal/{session_key}/clear-history")
async def terminal_clear_history(session_key: str):
    clear_persist(session_key)
    s = _sessions.get(session_key)
    if s is not None:
        s.buffer = ""
        s._persist_pending = ""
    return {"ok": True}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `.venv/bin/python -m pytest backend/tests/test_terminal_persistence.py -v`
Expected: PASS — endpoint tests pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add backend/terminals.py backend/tests/test_terminal_persistence.py
git commit -m "feat(terminal): persist-toggle + clear-history REST endpoints"
```

---

### Task 5: Frontend — incognito toggle + clear-history on kill

**Files:**
- Modify: `frontend-overrides/js/workspace-terminal.js` — header markup in `createPanel` (lines 76-89), `p` object fields (lines 91-103), wire-up (lines 105-110), and `killPanel`; add `refreshPersist`/`renderPersist`/`togglePersist`

**Interfaces:**
- Consumes: the Task 4 endpoints.
- Produces: a `.wt-persist` header button per panel; `killPanel` additionally clears saved history (with confirm).

- [ ] **Step 1: Add the persist button to the header markup**

In the `el.innerHTML` template in `createPanel`, add this line immediately AFTER the `wt-pin` button line:

```js
        '<button class="wt-btn wt-persist" title="Saved history">💾</button>' +
```

- [ ] **Step 2: Add panel fields**

After `pinBtn: el.querySelector('.wt-pin'),` in the `p` object literal, add:

```js
      persistBtn: el.querySelector('.wt-persist'),
      persistEnabled: null,
```

- [ ] **Step 3: Wire the click + initial fetch**

After `p.pinBtn.addEventListener('click', () => togglePin(p));` add:

```js
    p.persistBtn.addEventListener('click', () => togglePersist(p));
    refreshPersist(p);
```

- [ ] **Step 4: Add the render/refresh/toggle functions (place near `toggleGary`/`renderGary`)**

```js
  function renderPersist(p) {
    const b = p.persistBtn; if (!b) return;
    if (p.persistEnabled === null) { b.textContent = '💾'; b.classList.remove('active'); b.title = 'Saved history'; return; }
    b.textContent = p.persistEnabled ? '💾' : '🚫';
    b.classList.toggle('active', !!p.persistEnabled);
    b.title = p.persistEnabled
      ? 'Saved history ON — contents persist across reboots. Click to go incognito (stop saving + wipe).'
      : 'Incognito — this terminal is NOT being saved. Click to start saving.';
  }
  function refreshPersist(p) {
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/persist')
      .then((r) => r.json())
      .then((d) => { p.persistEnabled = !!d.enabled; renderPersist(p); })
      .catch(() => {});
  }
  function togglePersist(p) {
    const next = !p.persistEnabled;
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/persist', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: next }),
    }).then((r) => r.json())
      .then((d) => { p.persistEnabled = !!d.enabled; renderPersist(p); })
      .catch(() => {});
  }
```

- [ ] **Step 5: Fold clear-history into `killPanel`**

The existing `killPanel` (around line 315) is:

```js
  function killPanel(p) {            // terminate the PTY
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/close', { method: 'POST' }).catch(() => {});
    disconnectPanel(p);
    if (p.term) { try { p.term.dispose(); } catch (e) {} }
    p.el.remove();
    p.term = null; p.fit = null;
    panels.delete(p.id);
```

Add a confirm gate + clear-history fetch at the TOP, preserving every existing line. The result:

```js
  function killPanel(p) {            // terminate the PTY
    if (!confirm('End this terminal and erase its saved history?')) return;
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/clear-history', { method: 'POST' }).catch(() => {});
    fetch('/api/terminal/' + encodeURIComponent(p.id) + '/close', { method: 'POST' }).catch(() => {});
    disconnectPanel(p);
    if (p.term) { try { p.term.dispose(); } catch (e) {} }
    p.el.remove();
    p.term = null; p.fit = null;
    panels.delete(p.id);
```

Leave the remainder of the function (anything after `panels.delete(p.id);`) exactly as-is. Do NOT remove the existing teardown calls.

- [ ] **Step 6: Verify**

Run: `cd /Users/admin/openclaw-workspace && node --check frontend-overrides/js/workspace-terminal.js && node --test frontend-overrides/js/__tests__/workspace-terminal-config.test.js frontend-overrides/js/__tests__/workspace-terminal-layout.test.js`
Expected: valid + 7/7 tests pass (no regression). Visual behavior (button toggles 💾/🚫, kill confirms + wipes) is eyeball-verified after deploy — the project forbids headless Chrome.

- [ ] **Step 7: Commit**

```bash
cd /Users/admin/openclaw-workspace
git add frontend-overrides/js/workspace-terminal.js
git commit -m "feat(terminal): incognito toggle + clear-history on kill"
```

---

## Deploy & verify (controller, after final review)

This batch changes the **backend**, so unlike the slickness batch it requires a workspace restart to go live.

1. Merge to main; run `scripts/sync-frontend.sh`.
2. Restart the workspace: `launchctl bootout gui/$(id -u)/ai.openclaw.workspace; sleep 1; launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/ai.openclaw.workspace.plist` — retry once on "5: I/O error". (Cold boot can take minutes on the mini; do NOT restart repeatedly.)
3. Smoke: `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8800/api/terminal/smoke-key/persist` → `200` with `{"enabled":true}`.
4. User morning eyeball: open a terminal, run a command, close the panel, reopen → prior output replays above a "restored …" separator; 💾 toggles to 🚫 (incognito); 🗑 confirms + wipes.

Note: on the current macOS mini, **cwd restore is best-effort** (no `/proc`) → reopened shells start at the workspace root; contents still restore. Full cwd restore lands on the GEEKOM Linux box. At-rest safety depends on **LUKS** there (migration checklist).

## Self-Review

- **Spec coverage:** storage+scrubber (Task 1); batched flush + persist flag + close-flush (Task 2); restore contents+cwd + separator + prune (Task 3); incognito + clear-history backend (Task 4) + frontend (Task 5); retention via `_maybe_prune` + delete-on-clear (Tasks 1/3/4); security (perms in Task 1, scrubber Task 1, LUKS in the migration plan, output-only capture by construction). ✓
- **Placeholder scan:** all steps carry complete code/commands; no TBD.
- **Type consistency:** `persist_log_path`/`persist_dir`/`read_meta`/`write_meta`/`is_persist_enabled`/`set_persist`/`clear_persist`/`load_tail`/`read_cwd`/`prune_persist`/`scrub` names are identical across Tasks 1-4; `flush_persist`/`self.persist`/`self._persist_pending` consistent across Tasks 2-4; endpoints' paths match the frontend fetch URLs in Task 5.
- **Non-goal guard:** nothing here resumes live processes (Tiers B/C); tmux is untouched.
