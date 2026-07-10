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
    documented miss (conservative by design)."""
    return _QUOTED_RE.sub(" ", command)


def is_exec_tool(name: str | None, *, item_is_command: bool = False) -> bool:
    """Only shell-ish tools carry commands worth sniffing. The OpenAI-style
    relay path marks command items structurally (item_is_command); the
    claude-cli path is gated by tool name."""
    if item_is_command:
        return True
    return (name or "").strip().lower() in _EXEC_TOOLS


def looks_background(command: str | None) -> bool:
    if not command or not isinstance(command, str):
        return False
    text = _unquoted(command)
    return any(p.search(text) for p in _BG_PATTERNS)


def core_command(command: str) -> str:
    """The command with backgrounding tokens stripped — the human-readable
    promise label AND the pgrep -f pattern. 80 chars keeps labels sane."""
    core = re.sub(r"(?:^\s*|(?<=[;&|(]\s)|(?<=&&\s))(?:nohup|setsid)\s+", "",
                  command.strip())
    core = re.sub(r"(?<![&|])&\s*$", "", core)
    core = re.sub(r"\bdisown\b", "", core)
    core = re.sub(r"\s+", " ", core).strip()
    return core[:80]


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
        launch_ms = int(time.time() * 1000)
        turn_id = None
        try:
            info = turn_state.inflight_for(session_key)
            if info:
                turn_id = info.get("turn_id")
        except Exception:  # noqa: BLE001
            pass
        try:
            task = asyncio.get_running_loop().create_task(
                _run(session_key, session_id, command, launch_ms, turn_id))
        except RuntimeError:
            return False           # no loop (tests/CLI) — skip silently
        _TASKS.add(task)
        task.add_done_callback(_TASKS.discard)
        return True
    except Exception:  # noqa: BLE001 - the sniffer must never break the relay
        log.warning("launch_sniffer.on_tool_start failed", exc_info=True)
        return False


async def _run(session_key: str, session_id: str, command: str,
               launch_ms: int, turn_id) -> None:
    """Grace → register → watch. Every stage is best-effort; the promise's
    deadline backstop is the safety net for anything that dies here."""
    try:
        await asyncio.sleep(GRACE_S)
        if task_registry.has_session_registration_since(session_key, launch_ms):
            return                 # Gary (or the wrapper) did the right thing
        core = core_command(command)
        rec = followup.create_promise(session_id, session_key, core,
                                      AUTO_DEADLINE_S, origin="auto",
                                      turn_id=turn_id)
        start = time.time()
        pid = await _find_pid(core)
        if pid is None:
            log.info("launch_sniffer: no pid for %r — deadline-only promise %s",
                     core, rec["id"])
            return                 # 4h backstop fires the honest turn
        while _pid_alive(pid, core):
            if time.time() - start > AUTO_DEADLINE_S:
                log.info("launch_sniffer: watcher for %r outlived the %ss cap; "
                         "stopping — the deadline backstop owns promise %s",
                         core, AUTO_DEADLINE_S, rec["id"])
                return
            await asyncio.sleep(WATCH_POLL_S)
        followup.record_completion(
            rec["id"], exit_code=-1, duration_s=time.time() - start,
            tail="auto-watched process exited; real exit code unknown — "
                 "inspect the artifacts")
        # The 30s followup sweeper fires the turn (recorded-but-unfired path).
    except Exception:  # noqa: BLE001
        log.warning("launch_sniffer watch failed for session %s", session_key,
                    exc_info=True)


async def _find_pid(core: str):
    """Newest process whose command line matches the launched command.
    Same-host guarantee: the gateway runs Gary's tools on this machine."""
    # re.escape: pgrep -f treats the pattern as an ERE — a raw '|' in the
    # command becomes alternation and can bind the watcher to the wrong
    # process. '--' guards against a core that starts with '-'.
    pattern = re.escape(core[:60])
    for _ in range(PID_TRIES):
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
        await asyncio.sleep(PID_RETRY_S)
    return None


def _pid_alive(pid: int, core: str) -> bool:
    """Alive AND still the same command (guards PID reuse). cmdline is
    NUL-separated; a loose substring check on the first token set is enough —
    the pgrep match already anchored the full pattern."""
    try:
        cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
    except OSError:
        return False
    if not cmdline:
        return False
    joined = cmdline.replace(b"\x00", b" ").decode("utf-8", "replace")
    first_token = (shlex.split(core) or [""])[0]
    return bool(first_token) and first_token in joined
