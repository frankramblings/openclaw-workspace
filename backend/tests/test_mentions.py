"""backend.mentions: parse @[Title](note|doc:id) tokens out of a chat
message, resolve them against the vault, and format a citation-friendly
context block using the same message-text-prefix convention as
websearch.context_block / attachments._prepend_text_attachments."""
from __future__ import annotations

import pytest

from backend import mentions


# --- MENTION_RE / parse_mentions --------------------------------------------

@pytest.mark.parametrize("text,expected", [
    ("check @[My Note](note:abc123def456)", [("note", "abc123def456", "My Note")]),
    ("see @[Doc Title](doc:xyz-9_8)", [("doc", "xyz-9_8", "Doc Title")]),
    ("no mention here", []),
    ("email me at frank@example.com please", []),  # bare @ never matches
    ("@[Bad](file:abc123)", []),                    # unknown kind
    ("@[Bad](note:abc/def)", []),                   # id charset
    ("@[Nested[Bracket]](note:abc)", []),            # nested brackets never close the title
    ("@[](note:abc)", []),                           # empty title (min length 1)
    ("@[" + ("x" * 201) + "](note:abc)", []),        # title over 200 chars
])
def test_mention_re_accept_reject(text, expected):
    got = [(m.kind, m.id, m.title) for m in mentions.parse_mentions(text)]
    assert got == expected


def test_parse_mentions_dedupes_by_kind_and_id_keeping_first_occurrence():
    text = "@[First](note:a) middle @[Second](note:a) end"
    out = mentions.parse_mentions(text)
    assert len(out) == 1
    assert out[0].title == "First"  # first occurrence wins


def test_parse_mentions_caps_at_eight_distinct():
    text = " ".join(f"@[T{i}](note:id{i})" for i in range(10))
    out = mentions.parse_mentions(text)
    assert len(out) == 8
    assert [m.id for m in out] == [f"id{i}" for i in range(8)]


def test_parse_mentions_preserves_order_and_span():
    text = "before @[B](doc:d1) after @[A](note:n1) end"
    out = mentions.parse_mentions(text)
    assert [m.title for m in out] == ["B", "A"]
    assert text[out[0].span[0]:out[0].span[1]] == "@[B](doc:d1)"


def test_parse_mentions_empty_text():
    assert mentions.parse_mentions("") == []
    assert mentions.parse_mentions(None) == []


# --- resolve -----------------------------------------------------------------

def test_resolve_note_found(vault_notes):
    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    out = mentions.resolve([mentions.Mention("note", "n1", "stale title", (0, 0))])
    assert len(out) == 1
    r = out[0]
    assert r.missing is False
    assert r.title == "Groceries"  # disk title wins over the stale token title
    assert r.body == "Milk, eggs.\n"
    assert r.truncated is False


def test_resolve_doc_found(vault_docs):
    doc = vault_docs(id="d1", title="Runbook", current_content="# Runbook\n\nSteps.\n")
    out = mentions.resolve([mentions.Mention("doc", "d1", "x", (0, 0))])
    assert out[0].missing is False
    assert out[0].title == "Runbook"
    assert out[0].body == "# Runbook\n\nSteps.\n"


def test_resolve_missing_note_and_doc():
    out = mentions.resolve([
        mentions.Mention("note", "nope", "Ghost Note", (0, 0)),
        mentions.Mention("doc", "nope2", "Ghost Doc", (0, 0)),
    ])
    assert [r.missing for r in out] == [True, True]
    assert [r.title for r in out] == ["Ghost Note", "Ghost Doc"]  # falls back to token title
    assert [r.body for r in out] == ["", ""]


def test_resolve_doc_load_raising_is_treated_as_missing(monkeypatch):
    """documents._load only checks p.exists() before reading; a TOCTOU
    delete, a permission error, or a decode error on the vault file can
    still raise. resolve() must treat that the same as "not found" (a
    not-found line, no exception), exactly as it already does for a note
    whose vault file fails to load."""
    def boom(_doc_id):
        raise OSError("disk exploded")
    monkeypatch.setattr(mentions.documents, "_load", boom)
    out = mentions.resolve([mentions.Mention("doc", "d1", "Ghost Doc", (0, 0))])
    assert out[0].missing is True
    assert out[0].title == "Ghost Doc"  # falls back to the token title
    assert out[0].body == ""
    block = mentions.context_block(out)
    assert "── Document: Ghost Doc (not found) ──" in block


def test_resolve_per_item_truncation(vault_notes):
    big = ("x" * (mentions._ITEM_MAX_BYTES + 500))
    vault_notes(note_id="n1", title="Big", body=big)
    out = mentions.resolve([mentions.Mention("note", "n1", "Big", (0, 0))])
    r = out[0]
    assert r.truncated is True
    assert len(r.body.encode("utf-8")) <= mentions._ITEM_MAX_BYTES + len("\n[truncated]")
    assert r.body.endswith("[truncated]")


# --- context_block -------------------------------------------------------------

def test_context_block_format_and_not_found_line(vault_notes):
    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    resolved = mentions.resolve([
        mentions.Mention("note", "n1", "x", (0, 0)),
        mentions.Mention("doc", "gone", "Missing Doc", (0, 0)),
    ])
    block = mentions.context_block(resolved)
    assert block.startswith(
        "The user referenced the following notes and documents. "
        "Cite them as [Title] when you use them.\n\n")
    assert "── Note: Groceries ──\nMilk, eggs.\n" in block
    assert "── Document: Missing Doc (not found) ──" in block
    assert "—" not in block  # no em dashes anywhere in the injected copy


def test_context_block_heading_anchors_for_documents(vault_docs):
    body = "# Guide\n\nIntro text.\n\n## Setup\n\nDo X.\n"
    vault_docs(id="d1", title="Guide", current_content=body)
    resolved = mentions.resolve([mentions.Mention("doc", "d1", "x", (0, 0))])
    block = mentions.context_block(resolved)
    assert "# Guide [Guide › Guide]" in block
    assert "## Setup [Guide › Setup]" in block
    # Notes are never heading-annotated (only documents, per spec 4.1).


def test_context_block_total_cap_truncates_later_items(vault_notes):
    """A 2-item version of this scenario can never exercise context_block's
    OWN total-cap logic: resolve()'s per-item 100 KB cap already clips any
    single item over _ITEM_MAX_BYTES before context_block ever sees it, and
    two items that both stay under that per-item cap can sum to at most
    2 * _ITEM_MAX_BYTES == _TOTAL_MAX_BYTES exactly, never over it. So this
    uses three items, each individually under the per-item cap (none of
    them truncated by resolve()), where only the cumulative total at the
    third item crosses the 200 KB total cap."""
    a = "a" * 80000
    b = "b" * 80000
    c = "c" * 50000
    vault_notes(note_id="n1", title="A", body=a)
    vault_notes(note_id="n2", title="B", body=b)
    vault_notes(note_id="n3", title="C", body=c)
    resolved = mentions.resolve([
        mentions.Mention("note", "n1", "x", (0, 0)),
        mentions.Mention("note", "n2", "x", (0, 0)),
        mentions.Mention("note", "n3", "x", (0, 0)),
    ])
    assert [r.truncated for r in resolved] == [False, False, False]
    block = mentions.context_block(resolved)
    remaining_for_c = mentions._TOTAL_MAX_BYTES - len(a) - len(b)
    expected_c = "── Note: C ──\n" + ("c" * remaining_for_c) + "\n[truncated]"
    assert expected_c in block
    assert "── Note: A ──\n" + a in block
    assert "── Note: B ──\n" + b in block
    # total body content stays within a small constant overhead of the cap
    body_bytes = len(block.encode("utf-8"))
    assert body_bytes < mentions._TOTAL_MAX_BYTES + 2000


# --- prepend_mentions / strip_context_block (display split) --------------------

def test_prepend_mentions_no_mentions_is_a_noop():
    msg, had = mentions.prepend_mentions("hello Gary")
    assert msg == "hello Gary"
    assert had is False


def test_prepend_mentions_wraps_with_marker_and_strip_round_trips(vault_notes):
    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    original = "what's on my list? @[Groceries](note:n1)"
    wrapped, had = mentions.prepend_mentions(original)
    assert had is True
    assert wrapped.endswith(
        "\n\n---\n\nUser message (mentions resolved above): " + original)
    assert mentions.strip_context_block(wrapped) == original


def test_strip_context_block_passthrough_for_non_matching_and_non_string():
    assert mentions.strip_context_block("just a normal message") == "just a normal message"
    assert mentions.strip_context_block(None) is None
    assert mentions.strip_context_block([{"type": "text"}]) == [{"type": "text"}]


def test_strip_context_block_composes_with_websearch_in_either_order(vault_notes):
    """Production nesting: prepend_mentions wraps the raw message first, at
    the composer/route boundary; chat_turn.py's websearch.context_block
    wraps around that already-mentions-wrapped text later. Display code
    (e.g. /api/history) must be able to call the two strip functions in
    either order and still recover the exact original user text, since the
    mentions block ends up sitting in the middle of the fully composed
    string, not at its start."""
    from backend import websearch

    vault_notes(note_id="n1", title="Groceries", body="Milk, eggs.\n")
    original = "what's on my list? @[Groceries](note:n1)"
    wrapped_mentions, had = mentions.prepend_mentions(original)
    assert had is True
    composed = websearch.context_block(
        wrapped_mentions,
        [{"title": "Result", "url": "https://example.com", "snippet": "snippet text"}],
    )

    # Order 1: websearch's own wrap peeled off first, then the mentions wrap.
    assert mentions.strip_context_block(websearch.strip_context_block(composed)) == original

    # Order 2: the mentions wrap peeled off first, then websearch's own wrap.
    assert websearch.strip_context_block(mentions.strip_context_block(composed)) == original
