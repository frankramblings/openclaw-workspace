"""Detect bare background launches in relayed tool calls (Phase 3 sniffer).

The pure half: pattern-match a tool_start's command text. Conservative by
design — every pattern is an explicit backgrounding idiom (nohup/setsid at a
command position, trailing '&', disown, detached screen/tmux). A missed
launch is the status quo (nothing tracked); a false positive registers a
harmless watched promise whose worst case is one honest deadline turn.
"""
from __future__ import annotations

import re

_EXEC_TOOLS = {"bash", "shell", "exec", "local_shell", "run_shell_command",
               "command", "commands"}

_BG_PATTERNS = (
    re.compile(r"(?:^\s*|[;&|(]\s*)nohup\s"),
    re.compile(r"(?:^\s*|[;&|(]\s*)setsid\s"),
    re.compile(r"(?:^\s*|[;&|(]\s*)disown\b"),
    re.compile(r"(?<![&|])&\s*$"),
    re.compile(r"\bscreen\s+-\w*d\w*m\w*\b"),
    re.compile(r"\btmux\s+new(?:-session)?\s+(?:\S+\s+)*-d(?:\s|$)"),
)

_QUOTED_RE = re.compile(r"'[^']*'|\"[^\"]*\"")


def _unquoted(command: str) -> str:
    """Patterns run on the command with quoted spans removed — prose ABOUT
    backgrounding ('use nohup…', 'Step 1; nohup…') can't fire them, while a
    real launch's tokens live outside quotes. bash -c 'nohup x' stays a
    documented miss (conservative by design). Quote pairing is per-line since
    detection went line-scoped: a quoted multi-line block containing a
    backgrounding idiom on its own line can false-fire — accepted, within the
    module's FP tolerance (worst case: one honest deadline turn)."""
    return _QUOTED_RE.sub(" ", command)


def is_exec_tool(name: str | None, *, item_is_command: bool = False) -> bool:
    """Only shell-ish tools carry commands worth sniffing. The OpenAI-style
    relay path marks command items structurally (item_is_command); the
    claude-cli path is gated by tool name."""
    if item_is_command:
        return True
    return (name or "").strip().lower() in _EXEC_TOOLS


def background_line(command: str | None) -> str | None:
    """First line of the command blob that is a background launch, or None.
    Detection and pattern-derivation are LINE-scoped: terminal payloads are
    often multi-command blobs, and the pgrep pattern must come from the
    launching line only — not swallow unrelated adjacent lines."""
    if not command or not isinstance(command, str):
        return None
    for line in command.splitlines():
        text = _unquoted(line)
        if any(p.search(text) for p in _BG_PATTERNS):
            return line.strip()
    return None


def looks_background(command: str | None) -> bool:
    return background_line(command) is not None


def core_command(command: str) -> str:
    """The command with backgrounding tokens stripped — the human-readable
    promise label AND the pgrep -f pattern. 80 chars keeps labels sane."""
    line = background_line(command) or command.strip()
    core = re.sub(r"(?:^\s*|(?<=[;&|(]\s)|(?<=&&\s))(?:nohup|setsid)\s+", "",
                  line)
    core = re.sub(r"(?<![&|])&\s*$", "", core)
    core = re.sub(r"\bdisown\b", "", core)
    core = re.sub(r"\s+", " ", core).strip()
    return core[:80]


_PATTERN_STOP_RE = re.compile(r"[><|;]|&&")


def watch_pattern(core: str) -> str:
    """The pgrep -f pattern: the core command truncated at the first
    redirection/control operator (those tokens never appear in the child's
    argv — `nohup x > log 2>&1 &` execs `x` with fds redirected, so `>`,
    `2>&1`, `|`, `;`, `&&` never show up in /proc/<pid>/cmdline), then
    length-capped. The label (core_command's return value) keeps the full
    text; only the process match uses this narrower slice."""
    cut = _PATTERN_STOP_RE.search(core)
    base = core[:cut.start()] if cut else core
    return base.strip()[:60]


import asyncio  # noqa: E402
import logging  # noqa: E402
import shlex  # noqa: E402
import time  # noqa: E402
from pathlib import Path  # noqa: E402

from . import followup, task_registry, turn_state  # noqa: E402
from .sessions_store import id_for_session_key as _session_id_for  # noqa: E402

log = logging.getLogger(__name__)

GRACE_S = 10.0
AUTO_DEADLINE_S = 4 * 3600
WATCH_POLL_S = 5.0
PID_TRIES = 3
PID_RETRY_S = 2.0

# Keep strong refs so fire-and-forget watch tasks aren't garbage-collected.
_TASKS: set = set()

# Per-session count of sniffed launches whose grace window hasn't resolved
# yet (registration outcome not yet decided: still sleeping, or past the
# sleep but the create-promise/skip decision hasn't landed). See
# grace_pending() and _run()'s comment for why the decrement can't happen
# right after the sleep.
_GRACE_PENDING: dict[str, int] = {}

# (session_key, core) pairs with a live grace/watch task — dedupes a repeat
# sniff of the same launch while the first one is still pending/watched.
_ACTIVE: set = set()


def _dec_grace(session_key: str) -> None:
    n = _GRACE_PENDING.get(session_key, 0) - 1
    if n > 0:
        _GRACE_PENDING[session_key] = n
    else:
        _GRACE_PENDING.pop(session_key, None)


def cancel_all() -> int:
    """Cancel every live sniffer task (app shutdown). The persisted promises
    and their deadline backstops survive; only the in-process watchers die."""
    tasks = list(_TASKS)
    for t in tasks:
        t.cancel()
    return len(tasks)


def grace_pending(session_key: str) -> bool:
    """True while at least one sniffed launch for this session is inside its
    grace window (registration outcome not yet decided). The promise guard
    suppresses its warning card in that state — the launch WILL be tracked
    one way or the other."""
    return _GRACE_PENDING.get(session_key, 0) > 0


def on_tool_start(session_key: str | None, tool_name: str | None,
                  command: str | None, *, item_is_command: bool = False) -> bool:
    """Bridge hook. Synchronous, MUST never raise (the relay calls it inside
    its own guard, but defense in depth). Returns True iff a grace-watch was
    scheduled."""
    try:
        if not session_key or not command:
            return False
        if not is_exec_tool(tool_name, item_is_command=item_is_command):
            return False
        if not looks_background(command):
            return False
        session_id = _session_id_for(session_key)
        if not session_id:
            return False           # not a web chat — Signal etc. are out of scope
        # Dedupe: a repeat sniff of the same (session_key, core) while the
        # first one is still pending/watched is a no-op — one grace/watch per
        # distinct launch, not one per tool_start frame.
        core = core_command(command)
        key = (session_key, core)
        if key in _ACTIVE:
            return False
        _ACTIVE.add(key)
        launch_ms = int(time.time() * 1000)
        turn_id = None
        try:
            info = turn_state.inflight_for(session_key)
            if info:
                turn_id = info.get("turn_id")
        except Exception:  # noqa: BLE001
            pass
        # Mark the grace window pending BEFORE handing off to the loop so
        # there's no gap between "decided to watch" and "promise_guard can
        # see it's watching." Rolled back below if scheduling fails (no
        # running loop) — nothing will ever decrement it otherwise.
        _GRACE_PENDING[session_key] = _GRACE_PENDING.get(session_key, 0) + 1
        try:
            task = asyncio.get_running_loop().create_task(
                _run(session_key, session_id, core, launch_ms, turn_id))
        except RuntimeError:
            _dec_grace(session_key)
            _ACTIVE.discard(key)
            return False           # no loop (tests/CLI) — skip silently
        _TASKS.add(task)
        task.add_done_callback(_TASKS.discard)
        return True
    except Exception:  # noqa: BLE001 - the sniffer must never break the relay
        log.warning("launch_sniffer.on_tool_start failed", exc_info=True)
        return False


async def _run(session_key: str, session_id: str, core: str,
               launch_ms: int, turn_id) -> None:
    """Grace → register → watch. Every stage is best-effort; the promise's
    deadline backstop is the safety net for anything that dies here.

    _GRACE_PENDING stays incremented (see on_tool_start) until the
    REGISTRATION DECISION below is fully made — either "something else
    registered" or "the auto promise now exists" — not merely until the
    sleep ends. Decrementing right after the sleep would open a window where
    grace_pending() already reads False but no promise exists yet, letting
    the promise guard's "you will NOT be pinged" card race ahead of the
    auto-registration that pings. So the sleep-through-create_promise span is
    wrapped in its own try/finally, with the decrement in the finally — that
    fires exactly once, on every exit path (return or exception).

    The `_ACTIVE` entry is a SEPARATE, OUTER finally: it must survive past the
    registration decision, for as long as the watch (if any) keeps running —
    otherwise a duplicate launch sniffed mid-watch would race a second grace
    window for the same command. So `_ACTIVE` releases only when this whole
    coroutine ends (return or exception), strictly after — not nested inside
    — the grace-decrement finally above.
    """
    key = (session_key, core)
    try:
        try:
            await asyncio.sleep(GRACE_S)
            if task_registry.has_session_registration_since(session_key, launch_ms):
                return             # Gary (or the wrapper) did the right thing
            rec = followup.create_promise(session_id, session_key, core,
                                          AUTO_DEADLINE_S, origin="auto",
                                          turn_id=turn_id)
        finally:
            _dec_grace(session_key)
        await _watch_and_complete(rec["id"], core)
        # The 30s followup sweeper fires the turn (recorded-but-unfired path).
    except Exception:  # noqa: BLE001
        log.warning("launch_sniffer watch failed for session %s", session_key,
                    exc_info=True)
    finally:
        _ACTIVE.discard(key)


def rearm_watch(promise_id: str, label: str) -> bool:
    """Re-arm the process watcher for an auto promise that survived a
    restart. Asyncio tasks don't persist across process boundaries, so a
    still-pending auto promise from before the restart has no watcher until
    this schedules one. `label` IS the core command (create_promise stored it
    verbatim as the promise's label), so there's no re-parsing of
    backgrounding tokens — just resume the watch half of _run. Fire-and-forget
    like on_tool_start: a no-op when no loop is running (the promise's own
    deadline backstop is still the safety net either way)."""
    async def _guarded() -> None:
        # Same contract as _run: a fire-and-forget task, so an unhandled
        # exception here would surface as an "exception never retrieved"
        # asyncio error instead of the log line the rest of the sniffer uses.
        try:
            await _watch_and_complete(promise_id, label)
        except Exception:  # noqa: BLE001
            log.warning("launch_sniffer rearm_watch failed for promise %s",
                        promise_id, exc_info=True)

    try:
        task = asyncio.get_running_loop().create_task(_guarded())
    except RuntimeError:
        return False               # no loop (tests/CLI) — skip silently
    _TASKS.add(task)
    task.add_done_callback(_TASKS.discard)
    return True


async def _watch_and_complete(promise_id: str, core: str) -> None:
    """Find the launched process and watch it to completion, recording the
    result on `promise_id`. Shared tail of _run() (fresh launch) and
    rearm_watch() (re-armed after a restart) — same watch contract either
    way, just a different path to "the promise already exists"."""
    start = time.time()
    pid = await _find_pid(core)
    if pid is None:
        log.info("launch_sniffer: no pid for %r — deadline-only promise %s",
                 core, promise_id)
        return                     # 4h backstop fires the honest turn
    pattern_core = watch_pattern(core)
    while _pid_alive(pid, pattern_core):
        if time.time() - start > AUTO_DEADLINE_S:
            log.info("launch_sniffer: watcher for %r outlived the %ss cap; "
                     "stopping — the deadline backstop owns promise %s",
                     core, AUTO_DEADLINE_S, promise_id)
            return
        await asyncio.sleep(WATCH_POLL_S)
    followup.record_completion(
        promise_id, exit_code=-1, duration_s=time.time() - start,
        tail="auto-watched process exited; real exit code unknown — "
             "inspect the artifacts")


async def _find_pid(core: str):
    """Newest process whose command line matches the launched command.
    Same-host guarantee: the gateway runs Gary's tools on this machine."""
    # re.escape: pgrep -f treats the pattern as an ERE — a raw '|' in the
    # command becomes alternation and can bind the watcher to the wrong
    # process. '--' guards against a core that starts with '-'. watch_pattern
    # truncates at the first redirection/control operator first — those
    # tokens never show up in the child's argv, so leaving them in the
    # pattern just makes real launches (`cmd > log 2>&1 &`) unmatchable.
    base = watch_pattern(core)
    if not base:
        return None            # empty pgrep -f pattern matches every process
    pattern = re.escape(base)
    for attempt in range(PID_TRIES):
        try:
            proc = await asyncio.create_subprocess_exec(
                "pgrep", "-f", "-n", "--", pattern,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.DEVNULL)
            out, _err = await proc.communicate()
            if proc.returncode == 0 and out.strip():
                return int(out.strip().splitlines()[-1])
        except Exception:  # noqa: BLE001
            log.warning("pgrep failed for %r", pattern, exc_info=True)
            return None
        if attempt < PID_TRIES - 1:
            await asyncio.sleep(PID_RETRY_S)
    return None


def _pid_alive(pid: int, core: str) -> bool:
    """Alive AND still the same command (guards PID reuse). `core` is the
    caller's watch_pattern(...)-truncated string (same basis _find_pid
    matched against) — cmdline is NUL-separated; a loose substring check on
    the first token set is enough, the pgrep match already anchored the full
    pattern."""
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False
    if not cmdline:
        return False
    joined = cmdline.replace(b"\x00", b" ").decode("utf-8", "replace")
    first_token = (shlex.split(core) or [""])[0]
    return bool(first_token) and first_token in joined
