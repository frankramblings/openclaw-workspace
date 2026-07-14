"""Collapse injected/system 'user' messages in a transcript to a compact card.

Some user-role messages in a session's transcript aren't things Frank actually
typed — they're machinery OpenClaw injects. The biggest offender is the
session-continuation seed: when a chat is continued/forked, OpenClaw prepends a
"Continue this conversation using the OpenClaw transcript below…" block that
carries the ENTIRE prior transcript as context. Rendered raw it shows up as a
giant "You" bubble (the "phantom message from Me" Frank flagged).

We rewrite each such message to a one-line ⚙️ card. The frontend already styles
any user message whose text starts with "⚙️ " as a discreet centered system pill
(see live/chat.js -> msg.sys, surfaces.js -> .msg-sys), so it reads as
"something happened here" instead of noise — and the prior-transcript context
isn't lost, it's just not shouted.

Adding a new pattern = one row in _PATTERNS. Keep prefixes anchored to the exact
literal OpenClaw emits so a real user message that merely starts similarly is
never hidden.
"""

import re

# (prefix, card-text) — first match wins. `prefix` is matched against the
# message with leading whitespace stripped, AFTER the terminal-control /
# web-search notes have already been peeled off upstream (see app.history).
_PATTERNS = (
    (
        "Continue this conversation using the OpenClaw transcript below as "
        "prior session history.",
        "⚙️ Session continued from prior transcript",
    ),
)


def _task_notification_card(stripped: str) -> str | None:
    """`<task-notification>…</task-notification>` is a background-task event the
    runtime injects as a user turn — collapse it to its summary + status."""
    if not stripped.startswith("<task-notification"):
        return None
    summary = re.search(r"<summary>(.*?)</summary>", stripped, re.S)
    status = re.search(r"<status>(.*?)</status>", stripped, re.S)
    label = summary.group(1).strip() if summary else "background task"
    state = status.group(1).strip() if status else ""
    return f"⚙️ Background task · {label}" + (f" ({state})" if state else "")


def history_card(content) -> str | None:
    """Return the compact ⚙️ card for an injected/system user message, or None
    for anything that looks like a genuine user message."""
    if not isinstance(content, str):
        return None
    stripped = content.lstrip()
    for prefix, card in _PATTERNS:
        if stripped.startswith(prefix):
            return card
    return _task_notification_card(stripped)
