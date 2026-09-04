"""Draft mode: the Cowork-style co-drafting turn loop.

When the SPA posts a turn with `active_doc_id` (chat.js sends it automatically
whenever the document panel is open, auto-saving the doc first), the turn is
doc-bound:

  pre_turn          — load the doc and snapshot its current body into the
                      existing version history. Direct agent edits are always
                      one restore away — this is the user's undo.
  wrap_message      — prefix the user message with a context note naming the
                      vault file and how to edit it safely.
  post_turn_payload — re-read the file after the turn; if the agent changed
                      the body, bump the version, canonically rewrite the
                      frontmatter (self-heals agent mangling), and return the
                      `doc_update` payload the SPA already renders
                      (chat.js type:"doc_update" → documentModule.handleDocUpdate).

Files are the medium: the agent edits the vault .md with its native file
tools — no bespoke edit protocol. Spec:
docs/superpowers/specs/2026-06-05-documents-drafting-mode-design.md
"""
from __future__ import annotations

import json

from . import documents, vault_store as vs

SELECTION_MAX_BYTES = 8 * 1024  # active_doc_selection FormData cap


def parse_selection(raw: str) -> dict | None:
    """Parse the optional active_doc_selection FormData field: JSON
    {"from": int|None, "to": int|None, "text": str}, capped at 8 KB. A
    selection hint is a nice-to-have that sharpens wrap_message's note, never
    a reason to fail the turn: any malformed, oversized, or empty input is
    silently ignored (returns None), same posture as this codebase's other
    soft-fail context injections (websearch.search, _prepend_text_attachments)."""
    if not raw:
        return None
    if len(raw.encode("utf-8")) > SELECTION_MAX_BYTES:
        return None
    try:
        data = json.loads(raw)
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    text = data.get("text")
    if not isinstance(text, str) or not text.strip():
        return None
    frm, to = data.get("from"), data.get("to")
    if frm is not None and not isinstance(frm, int):
        return None
    if to is not None and not isinstance(to, int):
        return None
    return {"from": frm, "to": to, "text": text}


def pre_turn(doc_id: str) -> dict | None:
    """Load + snapshot the doc before a doc-bound turn. None if it doesn't exist."""
    doc = documents._load(doc_id)
    if doc is None:
        return None
    # Always snapshot, even right after the SPA's pre-send auto-save (which has
    # its own snapshot of the *pre-save* body): this one captures the body the
    # agent is about to edit. Skipping it would leave that body unrecoverable.
    # Cost: an occasional duplicate-content version entry. Cheap undo > tidy history.
    documents._snapshot(doc)
    return doc


def wrap_message(message: str, doc: dict, selection: dict | None = None) -> str:
    """Prefix the user message with the co-drafting context note for this doc.
    `selection` (from parse_selection) names the exact passage the dock's
    Rewrite button (Task 5) always sends, and a typed message sends whenever
    the dock has a live selection when Send is pressed."""
    path = documents._path(doc["id"])
    note = (
        f'[draft mode] We are co-drafting the document "{doc.get("title") or "Untitled"}" '
        f"stored at {path}. The file starts with a `---` frontmatter block — never modify "
        "or remove it; edit only the markdown body below it. When I ask for changes to "
        "the document, apply them directly to that file with your file tools, then reply "
        "with one short line on what changed — do not paste the document back into chat. "
        "If I'm just asking a question, answer normally and leave the file alone."
    )
    text = selection.get("text") if selection else None
    if text:
        note += (
            ' The user has selected this passage in the editor; when asked to rewrite or '
            'edit "the selection", change exactly this text and leave the rest alone:\n'
            f'── selected passage ──\n{text}\n── end selected passage ──'
        )
    return note + "\n\n" + message


_WRAP_PREFIX = '[draft mode] We are co-drafting the document "'
_WRAP_TAIL = "leave the file alone.\n\n"
# When wrap_message received a selection, the note's closing sentence is no
# longer immediately followed by the blank line (a selection block comes
# between them, ending in this literal) -- see wrap_message. Try the plain
# tail first (the common case, and the only one before Pillar C2's selection
# hint existed), then this one, so a selection-wrapped message still strips
# down to exactly what the user typed instead of passing through unstripped.
_WRAP_SELECTION_TAIL = "── end selected passage ──\n\n"


def strip_wrapper(text):
    """Display-side inverse of wrap_message, for /api/history.

    Anchored at the start of the string, the only position wrap_message can
    put the note in, and it partitions on the note's fixed closing sentence
    so a message that merely quotes the wrapper somewhere in its middle is
    never touched. Non-string input and unwrapped text pass through."""
    if not isinstance(text, str) or not text.startswith(_WRAP_PREFIX):
        return text
    _, sep, rest = text.partition(_WRAP_TAIL)
    if sep:
        return rest
    _, sep, rest = text.partition(_WRAP_SELECTION_TAIL)
    return rest if sep else text


def post_turn_payload(doc: dict) -> dict | None:
    """Detect agent edits after a doc-bound turn → the `doc_update` SSE payload.

    `doc` is the dict pre_turn returned (its current_content is the pre-turn
    body — the SPA auto-saves before sending, so it's fresh). Returns None when
    the body is unchanged or the file vanished. NOTE: mutates `doc` in place
    (content/version/updated_at) — don't reuse it as pre-turn state afterwards."""
    p = documents._path(doc["id"])
    if not p.exists():
        return None
    _, body = vs.parse_frontmatter(p.read_text(encoding="utf-8"))
    if body == doc.get("current_content", ""):
        return None
    doc["current_content"] = body
    doc["version_count"] = doc.get("version_count", 1) + 1
    doc["updated_at"] = vs.now_iso()
    documents._write(doc)  # canonical frontmatter rewrite
    return {"type": "doc_update", "doc_id": doc["id"], "content": body,
            "version": doc["version_count"], "title": doc.get("title", ""),
            "language": doc.get("language", "markdown")}
