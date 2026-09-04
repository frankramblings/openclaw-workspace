"""One display-strip chain for stored user messages.

A stored user message can carry several layers of injected context that the
user never typed. `chat_turn.drive_turn` (plus the route boundary) applies
them in this outer-to-inner order:

    terminal-control / terminal-images notes   (prepended last, outermost)
    draft-mode co-drafting wrapper
    websearch context block
    branch-context preamble ("Frank: " lead)
    mentions context block                     (innermost, applied in the route)

Every strip below is anchored at the start of what is left, so they must run
in that same outer-to-inner order or an earlier layer blocks a later one from
ever matching. Both /api/history and the chat search indexer call this single
helper so the two views of a stored message can never drift apart.
"""
from __future__ import annotations

from . import draft_mode, mentions, terminals, websearch


def history_display_text(content):
    """Strip every injected wrap layer from a stored message. Non-string input
    and an unwrapped message pass through unchanged."""
    if not isinstance(content, str):
        return content
    content = terminals.strip_capability_note(content)
    content = draft_mode.strip_wrapper(content)
    content = websearch.strip_context_block(content)
    return mentions.strip_context_block(content)
