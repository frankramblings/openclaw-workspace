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
    re.compile(r"(?:^\s*|[;&|(]\s*|&&\s+)nohup\s"),
    re.compile(r"(?:^\s*|[;&|(]\s*|&&\s+)setsid\s"),
    re.compile(r"\bdisown\b"),
    re.compile(r"(?<![&|])&\s*$"),
    re.compile(r"\bscreen\s+-\w*d\w*m\w*\b"),
    re.compile(r"\btmux\s+new(?:-session)?\s+(?:\S+\s+)*-d(?:\s|$)"),
)


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
    return any(p.search(command) for p in _BG_PATTERNS)


def core_command(command: str) -> str:
    """The command with backgrounding tokens stripped — the human-readable
    promise label AND the pgrep -f pattern. 80 chars keeps labels sane."""
    core = re.sub(r"(?:^\s*|(?<=[;&|(]\s)|(?<=&&\s))(?:nohup|setsid)\s+", "",
                  command.strip())
    core = re.sub(r"(?<![&|])&\s*$", "", core)
    core = re.sub(r"\bdisown\b", "", core)
    core = re.sub(r"\s+", " ", core).strip()
    return core[:80]
