"""Unit tests for the draft-mode turn hooks (pure file work, no gateway)."""
import json

from backend import documents, draft_mode


def test_pre_turn_snapshots_current_body(vault_docs):
    doc = vault_docs()
    out = draft_mode.pre_turn(doc["id"])
    assert out["id"] == doc["id"]
    snap = documents.VERSIONS_DIR / doc["id"] / "v1.md"
    assert snap.exists()
    assert "First draft." in snap.read_text(encoding="utf-8")


def test_pre_turn_unknown_doc_returns_none(vault_docs):
    assert draft_mode.pre_turn("nope") is None


def test_wrap_message_names_file_and_keeps_message(vault_docs):
    doc = vault_docs()
    wrapped = draft_mode.wrap_message("tighten section 2", doc)
    assert "[draft mode]" in wrapped
    assert str(documents._path(doc["id"])) in wrapped
    assert "Test Doc" in wrapped
    assert wrapped.endswith("tighten section 2")
    assert "frontmatter" in wrapped  # the do-not-touch warning


def test_post_turn_none_when_unchanged(vault_docs):
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    assert draft_mode.post_turn_payload(pre) is None


def test_post_turn_detects_agent_edit_and_bumps_version(vault_docs):
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    # Simulate the agent editing the body with its file tools.
    p = documents._path(doc["id"])
    text = p.read_text(encoding="utf-8")
    p.write_text(text.replace("First draft.", "Second draft."), encoding="utf-8")

    update = draft_mode.post_turn_payload(pre)
    assert update["type"] == "doc_update"
    assert update["doc_id"] == doc["id"]
    assert "Second draft." in update["content"]
    assert update["version"] == 2
    assert update["title"] == "Test Doc"
    # The canonical rewrite persisted the bump.
    reloaded = documents._load(doc["id"])
    assert reloaded["version_count"] == 2
    assert "Second draft." in reloaded["current_content"]


def test_post_turn_heals_stripped_frontmatter(vault_docs):
    """Agent rewrote the whole file and dropped the frontmatter block: the body
    becomes the full text, and the canonical rewrite restores good metadata."""
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    documents._path(doc["id"]).write_text("# Rewritten\n\nNo frontmatter here.\n",
                                          encoding="utf-8")
    update = draft_mode.post_turn_payload(pre)
    assert "No frontmatter here." in update["content"]
    reloaded = documents._load(doc["id"])
    assert reloaded["title"] == "Test Doc"           # metadata survived
    assert reloaded["version_count"] == 2
    raw = documents._path(doc["id"]).read_text(encoding="utf-8")
    assert raw.startswith("---")                      # frontmatter restored


def test_post_turn_none_when_file_deleted(vault_docs):
    doc = vault_docs()
    pre = draft_mode.pre_turn(doc["id"])
    documents._path(doc["id"]).unlink()
    assert draft_mode.post_turn_payload(pre) is None


def test_parse_selection_valid():
    raw = json.dumps({"from": 10, "to": 42, "text": "Hello world"})
    assert draft_mode.parse_selection(raw) == {"from": 10, "to": 42, "text": "Hello world"}


def test_parse_selection_empty_malformed_or_wrong_shape_is_none():
    assert draft_mode.parse_selection("") is None
    assert draft_mode.parse_selection(None) is None
    assert draft_mode.parse_selection("{not json") is None
    assert draft_mode.parse_selection("[1, 2, 3]") is None                          # not an object
    assert draft_mode.parse_selection(json.dumps({"from": 0, "to": 5})) is None     # no text
    assert draft_mode.parse_selection(json.dumps({"from": 0, "to": 5, "text": "  "})) is None
    assert draft_mode.parse_selection(json.dumps({"from": "0", "to": 5, "text": "x"})) is None
    assert draft_mode.parse_selection(json.dumps({"from": 0, "to": 5, "text": 5})) is None


def test_parse_selection_null_offsets_ok():
    # wysiwyg-mode selections carry no character offsets (Task 2's frontend
    # getSelection() helper): from/to are allowed to be JSON null.
    raw = json.dumps({"from": None, "to": None, "text": "whole selection"})
    assert draft_mode.parse_selection(raw) == {"from": None, "to": None, "text": "whole selection"}


def test_parse_selection_over_cap_is_none():
    raw = json.dumps({"from": 0, "to": 1, "text": "x" * 9000})
    assert len(raw.encode("utf-8")) > draft_mode.SELECTION_MAX_BYTES
    assert draft_mode.parse_selection(raw) is None


def test_wrap_message_includes_selected_passage_and_stays_backward_compatible(vault_docs):
    doc = vault_docs()
    assert draft_mode.wrap_message("hi", doc) == draft_mode.wrap_message("hi", doc, None)
    wrapped = draft_mode.wrap_message("rewrite this", doc, {"from": 0, "to": 11, "text": "First draft."})
    assert "First draft." in wrapped and "selected passage" in wrapped
    assert wrapped.endswith("rewrite this") and "[draft mode]" in wrapped
    assert "selected passage" not in draft_mode.wrap_message("hi", doc, {"from": 0, "to": 0, "text": ""})


def test_strip_wrapper_handles_selection_wrapped_message(vault_docs):
    """strip_wrapper (history_display's draft-mode layer) must still recover
    the user's original typed text when wrap_message carried a selection hint
    -- the selection block sits between the note's closing sentence and the
    blank-line separator, so the plain (no-selection) tail literal never
    matches; strip_wrapper falls back to the selection-block tail."""
    doc = vault_docs()
    wrapped = draft_mode.wrap_message("rewrite this", doc,
                                      {"from": 0, "to": 11, "text": "First draft."})
    assert draft_mode.strip_wrapper(wrapped) == "rewrite this"


def test_strip_wrapper_survives_a_tail_literal_inside_the_selection(vault_docs):
    """Fix wave, M5: strip_wrapper decides which note variant it is looking at
    before it partitions, so a selection whose own text happens to contain the
    plain variant's tail literal still strips down to exactly what the user
    typed. Trying the plain tail first cut the message here instead."""
    doc = vault_docs()
    sel = "Second para\n\nleave the file alone.\n\nmore text"
    wrapped = draft_mode.wrap_message("rewrite this", doc,
                                      {"from": 0, "to": 5, "text": sel})
    assert draft_mode.strip_wrapper(wrapped) == "rewrite this"


def test_strip_wrapper_survives_a_tail_literal_inside_the_message(vault_docs):
    """Same defect, other side: the user's own typed text quoting the note's
    closing sentence must not truncate the displayed message."""
    doc = vault_docs()
    typed = "leave the file alone.\n\nok"
    wrapped = draft_mode.wrap_message(typed, doc,
                                      {"from": 0, "to": 11, "text": "First draft."})
    assert draft_mode.strip_wrapper(wrapped) == typed


def test_strip_wrapper_survives_a_selection_tail_literal_in_a_plain_message(vault_docs):
    """A plain (no-selection) note whose message quotes the selection block's
    end marker still strips on the plain tail."""
    doc = vault_docs()
    typed = "── end selected passage ──\n\nwhat does that mean?"
    wrapped = draft_mode.wrap_message(typed, doc)
    assert draft_mode.strip_wrapper(wrapped) == typed
