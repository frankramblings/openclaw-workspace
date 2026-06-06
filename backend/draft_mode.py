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

from . import documents, vault_store as vs


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


def wrap_message(message: str, doc: dict) -> str:
    """Prefix the user message with the co-drafting context note for this doc."""
    path = documents._path(doc["id"])
    note = (
        f'[draft mode] We are co-drafting the document "{doc.get("title") or "Untitled"}" '
        f"stored at {path}. The file starts with a `---` frontmatter block — never modify "
        "or remove it; edit only the markdown body below it. When I ask for changes to "
        "the document, apply them directly to that file with your file tools, then reply "
        "with one short line on what changed — do not paste the document back into chat. "
        "If I'm just asking a question, answer normally and leave the file alone.\n\n"
    )
    return note + message


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
