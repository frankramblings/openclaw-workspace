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
order.

strip_context_block below only ever matches _BLOCK_INTRO at the two
positions it can structurally occupy in text this module itself produced:
the very start of the string (no websearch wrap around it), or immediately
after websearch's own prefix + marker (websearch wrapped outside it). It
deliberately does NOT search for _BLOCK_INTRO at an arbitrary position
anywhere in the text: an unwrapped message that merely quotes the wrapper
format (for example a user pasting "The user referenced the following
notes ... User message: ...") is real user content, not our own wrap, and
must never be silently spliced out on /api/history display. Anchoring to
those two well-defined positions is what makes calling
mentions.strip_context_block and websearch.strip_context_block in EITHER
order recover the original user text when both wraps are present, while
still passing through anything else untouched.

Hooked into backend/app.py's chat_stream right after
_prepend_text_attachments, before _scrub_secrets (see Task 2). The steer
route (POST /api/chat/steer/{id}) does NOT call this module: steers are
short and the raw token text is still readable by the agent.
"""
from __future__ import annotations

import re
from typing import NamedTuple

from . import documents, notes, websearch
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
_BRANCH_PREAMBLE_PREFIX = (
    "For context, this conversation was branched from an earlier thread.")
_BRANCH_USER_LEAD = "\n\nFrank: "
_FENCE_RE = re.compile(r"^\s*(```|~~~)", re.MULTILINE)
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
    never annotated (no heading concept for a note body).

    Lines inside fenced code blocks (``` or ~~~) are left alone: a `#` there
    is a shell comment or a CSS id, not a section the model should cite."""
    out = []
    fence = None
    for line in body.split("\n"):
        mo = _FENCE_RE.match(line)
        if mo:
            marker = mo.group(1)
            if fence is None:
                fence = marker
            elif marker == fence:
                fence = None
            out.append(line)
            continue
        if fence is None:
            hm = _HEADING_RE.match(line)
            if hm:
                hashes, text = hm.group(1), hm.group(2).strip()
                line = f"{hashes} {text} [{title} › {text}]"
        out.append(line)
    return "\n".join(out)


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
    """Display-side inverse of prepend_mentions, for /api/history.

    Only ever matches _BLOCK_INTRO at the two positions it can structurally
    occupy in text this module (or this module nested inside websearch's
    wrap) produced, never at an arbitrary position found by searching the
    whole string: doing that would also match, and silently delete, a span
    out of a message that merely quotes the wrapper format without ever
    having gone through prepend_mentions.

    (a) The mentions block is the very start of `text` (no websearch wrap
        sits outside it): strip _BLOCK_INTRO through our own _CTX_MARKER.
    (b) `text` is websearch's own wrap around an already-mentions-wrapped
        message (chat_turn.py's real nesting order: prepend_mentions runs
        first, at the composer/route boundary, and the websearch wrap runs
        later, around that result). The mentions block can then only
        legitimately start immediately after websearch's own prefix and
        marker (backend.websearch._CTX_PREFIX / _CTX_MARKER, the same
        constants websearch.strip_context_block itself matches on); splice
        the mentions block out of exactly that position, leaving
        websearch's prefix and marker in place so websearch.strip_context_block
        still works on the result afterwards, in either call order.
    (c) `text` starts with the branch-context preamble
        (app._compose_outgoing_for_session's one-shot "For context, this
        conversation was branched..." block, which ends with "\n\nFrank: "
        before the user's text). The mentions block can then only
        legitimately start right after that "Frank: " lead; splice it out of
        exactly that position, leaving the preamble and the lead in place
        (the preamble itself is shown today by design).
    (d) Anything else, including non-string input and a message that merely
        contains the wrapper text somewhere in the middle, passes through
        untouched."""
    if not isinstance(text, str):
        return text

    if text.startswith(_BLOCK_INTRO):
        _, sep, rest = text.partition(_CTX_MARKER)
        return rest if sep else text

    if text.startswith(_BRANCH_PREAMBLE_PREFIX):
        before, sep, after = text.partition(_BRANCH_USER_LEAD + _BLOCK_INTRO)
        if sep:
            _, sep2, rest = after.partition(_CTX_MARKER)
            if sep2:
                return before + _BRANCH_USER_LEAD + rest

    if text.startswith(websearch._CTX_PREFIX):
        before, sep, after = text.partition(websearch._CTX_MARKER)
        if sep and after.startswith(_BLOCK_INTRO):
            _, sep2, rest = after.partition(_CTX_MARKER)
            if sep2:
                return before + sep + rest

    return text
