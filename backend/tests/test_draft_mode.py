"""Unit tests for the draft-mode turn hooks (pure file work, no gateway)."""
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
