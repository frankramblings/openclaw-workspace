"""Parse, resolve, and inject @mention tokens (@[Title](note:id) /
@[Title](doc:id)) that the composer's mention picker writes into the sent
message text.

Follows the SAME message-text-prefix injection convention every other
context source in this codebase uses (backend/websearch.py's
context_block/strip_context_block is the closest sibling), and reuses the
text-attachment size caps (backend/attachments.py: 100 KB per file, 200 KB
per turn) rather than inventing new ones.

Uses its own marker, distinct from websearch's "\n\n---\n\nUser message: ",
because in production the two wraps NEST: prepend_mentions runs first, at
the composer/route boundary, and chat_turn.py's websearch wrap runs later,
around the already-mentions-wrapped text. A shared marker string would let
websearch.strip_context_block's partition land on the outer occurrence only
and leave the inner mentions block (including note/document bodies) sitting
in the "stripped" history text whenever the two strips run in the wrong
order. strip_context_block below also searches for its own intro anywhere
in the text (not only at position 0) and splices around it, rather than
requiring it as a strict prefix like websearch.strip_context_block does:
this is what actually makes calling mentions.strip_context_block and
websearch.strip_context_block in EITHER order recover the original user
text, since the mentions block can legitimately sit in the middle of the
fully composed string.

Hooked into backend/app.py's chat_stream right after
_prepend_text_attachments, before _scrub_secrets (see Task 2). The steer
route (POST /api/chat/steer/{id}) does NOT call this module: steers are
short and the raw token text is still readable by the agent.
"""
from __future__ import annotations

import re
from typing import NamedTuple

from . import documents, notes
from . import vault_store as vs

MENTION_RE = re.compile(
    r"@\[(?P<title>[^\]\n]{1,200})\]\((?P<kind>note|doc):(?P<id>[A-Za-z0-9_-]{1,32})\)"
)
MAX_MENTIONS = 8

# Reuses attachments.py's exact cap VALUES (100 KB / 200 KB) as local
# constants rather than importing that module's private names: mentions.py
# has nothing else to do with attachments, and the caps are independently
# specified by spec ruling 12, not derived from attachments at runtime.
_ITEM_MAX_BYTES = 100 * 1024
_TOTAL_MAX_BYTES = 200 * 1024

_BLOCK_INTRO = ("The user referenced the following notes and documents. "
                "Cite them as [Title] when you use them.\n\n")
_CTX_MARKER = "\n\n---\n\nUser message (mentions resolved above): "
_KIND_LABEL = {"note": "Note", "doc": "Document"}
_HEADING_RE = re.compile(r"^(#{1,6})[ \t]+(.*)$", re.MULTILINE)


class Mention(NamedTuple):
    kind: str          # "note" | "doc"
    id: str
    title: str          # as typed in the token (may be stale)
    span: tuple[int, int]


class ResolvedMention(NamedTuple):
    kind: str
    id: str
    title: str          # disk title when found, else the token's title
    body: str            # "" when missing
    truncated: bool      # per-item 100 KB cap was applied
    missing: bool


def parse_mentions(text: str) -> list[Mention]:
    """Every @[Title](note|doc:id) token in `text`, in order, deduped by
    (kind, id) keeping the FIRST occurrence, capped at MAX_MENTIONS distinct
    mentions. A duplicate mention beyond the cap, or an extra mention token
    past the 8th distinct one, is left as literal text in the message (never
    truncates the message itself)."""
    if not text:
        return []
    seen: dict[tuple[str, str], Mention] = {}
    order: list[tuple[str, str]] = []
    for m in MENTION_RE.finditer(text):
        key = (m.group("kind"), m.group("id"))
        if key in seen:
            continue
        if len(order) >= MAX_MENTIONS:
            continue
        seen[key] = Mention(kind=m.group("kind"), id=m.group("id"),
                             title=m.group("title"), span=(m.start(), m.end()))
        order.append(key)
    return [seen[k] for k in order]


def _resolve_one(m: Mention) -> tuple[str | None, str]:
    """(body, title) for one mention, or (None, m.title) if not found."""
    if m.kind == "note":
        path = notes._path(m.id)
        if not path.exists():
            return None, m.title
        try:
            entry = vs.load_entry(path)
        except Exception:  # noqa: BLE001 - unreadable vault file, treat as missing
            return None, m.title
        return entry.get("content") or "", entry.get("title") or m.title
    try:
        doc = documents._load(m.id)
    except Exception:  # noqa: BLE001 - unreadable/corrupt vault file, treat as missing
        return None, m.title
    if doc is None:
        return None, m.title
    return doc.get("current_content") or "", doc.get("title") or m.title


def resolve(mentions_in: list[Mention]) -> list[ResolvedMention]:
    """Load each mention's current body from the vault. Applies the
    per-item 100 KB cap here (the 200 KB total-turn cap is applied later, in
    context_block, since it depends on the combined set)."""
    out: list[ResolvedMention] = []
    for m in mentions_in:
        body, title = _resolve_one(m)
        if body is None:
            out.append(ResolvedMention(kind=m.kind, id=m.id, title=title,
                                       body="", truncated=False, missing=True))
            continue
        truncated = False
        encoded = body.encode("utf-8")
        if len(encoded) > _ITEM_MAX_BYTES:
            body = encoded[:_ITEM_MAX_BYTES].decode("utf-8", errors="ignore") + "\n[truncated]"
            truncated = True
        out.append(ResolvedMention(kind=m.kind, id=m.id, title=title,
                                   body=body, truncated=truncated, missing=False))
    return out


def _annotate_headings(body: str, title: str) -> str:
    """Append a [Title › Heading] anchor to every markdown heading line in a
    document body, so Gary's citation instruction (context_block's intro)
    can point at a specific section: 'Cite them as [Title] ...' for a whole
    document, or '[Title › Heading]' for a section (spec 4.1). Notes are
    never annotated (no heading concept for a note body)."""
    def repl(mo: re.Match) -> str:
        hashes, text = mo.group(1), mo.group(2).strip()
        return f"{hashes} {text} [{title} › {text}]"
    return _HEADING_RE.sub(repl, body)


def context_block(resolved: list[ResolvedMention]) -> str:
    """Format resolved mentions as a citation-friendly context preamble.
    Enforces the 200 KB TOTAL cap across all item bodies combined (the
    per-item 100 KB cap already happened in resolve()); an item that would
    push the running total over budget is truncated further here, marked
    with the same "[truncated]" tail attachments.py uses."""
    parts: list[str] = []
    total = 0
    for r in resolved:
        label = _KIND_LABEL.get(r.kind, r.kind)
        if r.missing:
            parts.append(f"── {label}: {r.title} (not found) ──")
            continue
        body = _annotate_headings(r.body, r.title) if r.kind == "doc" else r.body
        encoded = body.encode("utf-8")
        remaining = _TOTAL_MAX_BYTES - total
        if remaining <= 0:
            body = "[truncated]"
        elif len(encoded) > remaining:
            body = encoded[:remaining].decode("utf-8", errors="ignore")
            if not body.endswith("[truncated]"):
                body = body.rstrip() + "\n[truncated]"
        total += len(body.encode("utf-8"))
        parts.append(f"── {label}: {r.title} ──\n{body}")
    return _BLOCK_INTRO + "\n\n".join(parts)


def prepend_mentions(message: str) -> tuple[str, bool]:
    """(brain_text, had_mentions). No mentions in `message` returns it
    unchanged (had_mentions False), exactly like websearch.context_block is
    skipped when there's nothing to inject."""
    found = parse_mentions(message)
    if not found:
        return message, False
    block = context_block(resolve(found))
    return f"{block}{_CTX_MARKER}{message}", True


def strip_context_block(text):
    """Display-side inverse of prepend_mentions, for /api/history: non-
    matching input, and non-string input, passes through untouched, same as
    websearch.strip_context_block.

    Unlike websearch.strip_context_block (which only matches its own intro
    as a strict prefix), this searches for _BLOCK_INTRO ANYWHERE in `text`
    and splices out everything from there through the following own-marker
    occurrence, keeping whatever text came before and after intact. That is
    required, not just a nicety: chat_turn.py's websearch wrap nests AROUND
    an already-mentions-wrapped message, so the mentions block sits in the
    MIDDLE of the fully composed text, not at position 0, whenever both a
    web search and a mention happened on the same turn. Because the two
    modules now use distinct markers (see the module docstring), searching
    for the first (leftmost) occurrence of _BLOCK_INTRO always lands on the
    genuine wrap rather than on anything coincidentally similar inside the
    user's own message, so this is safe to call before OR after
    websearch.strip_context_block: whichever one runs first strips its own
    layer and leaves the other module's wrap, if any, untouched for the
    second call to remove."""
    if not isinstance(text, str):
        return text
    idx = text.find(_BLOCK_INTRO)
    if idx == -1:
        return text
    _, sep, rest = text[idx:].partition(_CTX_MARKER)
    if not sep:
        return text
    return text[:idx] + rest
