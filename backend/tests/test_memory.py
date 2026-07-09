"""Behavioral tests for memory.py (the Odysseus memory panel over MEMORY.md).

Quarantine + PermissionError contract tests for memory._read_json already
live in test_corruption_quarantine.py (test_memory_overlay_corrupt_file_
quarantined, test_memory_read_json_raises_on_unreadable_file) — NOT
duplicated here. This file covers: _write_json/_read_json roundtrip, the
_parse/_BULLET markdown section parser (USER_SECTION bullets + continuation
lines), the list_memories pinned-overlay merge, add/update/delete/pin_memory
against a tmp MEMORY.md + DATA_DIR, auto_memory_enabled prefs, and a thin
TestClient pass over the routes proving they're wired to the tested core
functions (not re-testing the core logic through HTTP).
"""
from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

from backend import config, memory


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def mem_env(tmp_path, monkeypatch):
    """Redirect MEMORY.md + the overlay/prefs stores into tmp_path.

    memory.py binds _OVERLAY/_PREFS as module constants at import time from
    config.DATA_DIR (before any test runs), so conftest's autouse
    _isolated_data_dir redirect of config.DATA_DIR doesn't reach them —
    each store has to be patched directly, same as
    test_corruption_quarantine.py does. We also patch config.DATA_DIR itself
    so _write_json's `config.DATA_DIR.mkdir(...)` call creates the directory
    the stores actually live in (mirrors the real _OVERLAY/_PREFS = DATA_DIR
    / "..." relationship instead of drifting apart)."""
    data_dir = tmp_path / "data"
    monkeypatch.setattr(config, "DATA_DIR", data_dir)
    monkeypatch.setattr(memory, "_OVERLAY", data_dir / "memory_overlay.json")
    monkeypatch.setattr(memory, "_PREFS", data_dir / "memory_prefs.json")
    monkeypatch.setattr(memory, "MEMORY_MD", tmp_path / "MEMORY.md")
    return tmp_path


@pytest.fixture
def client():
    from backend.app import app
    return TestClient(app)


# --- _write_json / _read_json roundtrip --------------------------------------

def test_overlay_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(memory, "_OVERLAY", tmp_path / "memory_overlay.json")
    memory._write_json(memory._OVERLAY, {"k": "v"})
    assert memory._read_json(memory._OVERLAY, {}) == {"k": "v"}


def test_write_json_creates_missing_data_dir(mem_env):
    """First-run scenario: DATA_DIR doesn't exist yet when a store is first
    written (e.g. pin_memory called before any prior write)."""
    assert not config.DATA_DIR.exists()
    memory.pin_memory("abc123", True)
    assert config.DATA_DIR.exists()
    assert memory._OVERLAY.exists()
    assert memory._read_json(memory._OVERLAY, {}) == {"pinned": ["abc123"]}


def test_read_json_missing_file_returns_default(mem_env):
    assert not memory._PREFS.exists()
    assert memory._read_json(memory._PREFS, {"auto_memory": None}) == {"auto_memory": None}


# --- _parse / _BULLET: MEMORY.md section + bullet parsing -------------------

_FIXTURE_MD = (
    "# MEMORY.md\n"
    "\n"
    "## General\n"
    "- Likes strong coffee in the morning.\n"
    "  Grinds beans fresh each day.\n"
    "- Prefers dark mode everywhere.\n"
    "\n"
    "## User Notes\n"
    "- Uses fish shell, not bash.\n"
    "- Timezone is US/Pacific.\n"
    "\n"
    "## Auto-extracted\n"
    "- Mentioned working on a novel.\n"
)


def test_parse_splits_sections_and_joins_continuation_lines():
    items = memory._parse(_FIXTURE_MD)
    by_section: dict[str, list[str]] = {}
    for it in items:
        by_section.setdefault(it["section"], []).append(it["text"])

    assert by_section["General"] == [
        "Likes strong coffee in the morning.\nGrinds beans fresh each day.",
        "Prefers dark mode everywhere.",
    ]
    assert by_section["User Notes"] == [
        "Uses fish shell, not bash.",
        "Timezone is US/Pacific.",
    ]
    assert by_section[memory.USER_SECTION] == by_section["User Notes"]
    assert by_section["Auto-extracted"] == ["Mentioned working on a novel."]


def test_parse_assigns_stable_content_derived_ids():
    items = memory._parse(_FIXTURE_MD)
    ids = [it["id"] for it in items]
    assert len(ids) == len(set(ids))  # every bullet gets a distinct id
    assert items[0]["id"] == memory._mid(items[0]["text"])
    # re-parsing the identical text reproduces the identical ids (line
    # renumbering elsewhere in the file must not change an unrelated id)
    again = memory._parse(_FIXTURE_MD)
    assert [it["id"] for it in again] == ids


def test_parse_accepts_asterisk_bullets():
    items = memory._parse("## General\n* Star-bulleted fact.\n")
    assert [it["text"] for it in items] == ["Star-bulleted fact."]


def test_parse_orphan_bullet_before_any_heading_defaults_to_general():
    items = memory._parse("- Orphan bullet with no preceding header.\n")
    assert items[0]["section"] == "General"


def test_parse_ignores_h1_and_blank_lines_between_bullets():
    items = memory._parse("# Title\nsome preamble text\n## Notes\n- a fact\n")
    assert [it["section"] for it in items] == ["Notes"]
    assert [it["text"] for it in items] == ["a fact"]


def test_parse_empty_document_yields_no_items():
    assert memory._parse("") == []
    assert memory._parse("# MEMORY.md\n") == []


# --- list_memories: pinned-overlay merge -------------------------------------

def test_list_memories_defaults_unpinned_with_source_and_timestamp(mem_env):
    memory.MEMORY_MD.write_text(_FIXTURE_MD)
    items = memory.list_memories()
    assert len(items) == 5
    assert all(it["pinned"] is False for it in items)
    assert all(it["source"] == "MEMORY.md" for it in items)
    assert all(isinstance(it["timestamp"], int) and it["timestamp"] > 0 for it in items)


def test_list_memories_merges_pinned_overlay_by_id(mem_env):
    memory.MEMORY_MD.write_text(_FIXTURE_MD)
    items = memory.list_memories()
    target = next(it for it in items if it["text"] == "Prefers dark mode everywhere.")

    memory.pin_memory(target["id"], True)

    refreshed = memory.list_memories()
    pinned_ids = {it["id"] for it in refreshed if it["pinned"]}
    assert pinned_ids == {target["id"]}
    assert all(it["pinned"] is False for it in refreshed if it["id"] != target["id"])


def test_list_memories_missing_file_returns_empty_list(mem_env):
    assert not memory.MEMORY_MD.exists()
    assert memory.list_memories() == []


# --- add_memory ----------------------------------------------------------------

def test_add_memory_creates_user_section_when_file_absent(mem_env):
    item = memory.add_memory("Remember to water the plants.")
    assert item["category"] == memory.USER_SECTION
    assert item["pinned"] is False

    text = memory.MEMORY_MD.read_text()
    assert f"## {memory.USER_SECTION}" in text
    assert "- Remember to water the plants." in text
    assert any(it["text"] == "Remember to water the plants." for it in memory.list_memories())


def test_add_memory_appends_under_existing_section_in_order(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Existing fact.\n")
    memory.add_memory("New fact.")
    texts = [it["text"] for it in memory.list_memories() if it["category"] == memory.USER_SECTION]
    assert texts == ["Existing fact.", "New fact."]


def test_add_memory_custom_category_creates_new_section(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Unrelated.\n")
    memory.add_memory("Kickoff meeting next week.", category="Work")
    by_cat = {it["category"]: it["text"] for it in memory.list_memories()}
    assert by_cat["Work"] == "Kickoff meeting next week."
    assert by_cat[memory.USER_SECTION] == "Unrelated."


def test_add_memory_does_not_insert_into_a_later_sections_body(mem_env):
    """A bullet added to section A must land before section B's heading, not
    bleed into the next section's bullet list."""
    memory.MEMORY_MD.write_text(
        f"## {memory.USER_SECTION}\n- Note A.\n\n## Auto-extracted\n- Auto A.\n")
    memory.add_memory("Note B.")
    items = memory.list_memories()
    user_texts = [it["text"] for it in items if it["category"] == memory.USER_SECTION]
    auto_texts = [it["text"] for it in items if it["category"] == "Auto-extracted"]
    assert user_texts == ["Note A.", "Note B."]
    assert auto_texts == ["Auto A."]


# --- update_memory ---------------------------------------------------------------

def test_update_memory_replaces_bullet_text_in_place(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Old text.\n")
    mid = memory.list_memories()[0]["id"]

    updated = memory.update_memory(mid, "New text.")

    assert updated["text"] == "New text."
    assert updated["id"] == memory._mid("New text.")
    assert [it["text"] for it in memory.list_memories()] == ["New text."]


def test_update_memory_unknown_id_returns_none_and_does_not_touch_file(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Some fact.\n")
    before = memory.MEMORY_MD.read_text()
    assert memory.update_memory("deadbeef0000", "whatever") is None
    assert memory.MEMORY_MD.read_text() == before


def test_update_memory_carries_pin_forward_to_the_new_id(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Old text.\n")
    old_id = memory.list_memories()[0]["id"]
    memory.pin_memory(old_id, True)

    updated = memory.update_memory(old_id, "New text.")

    assert updated["pinned"] is True
    pins = set(memory._read_json(memory._OVERLAY, {}).get("pinned", []))
    assert old_id not in pins
    assert updated["id"] in pins


# --- delete_memory -----------------------------------------------------------

def test_delete_memory_removes_bullet_and_its_pin(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Keep me.\n- Delete me.\n")
    items = memory.list_memories()
    target = next(it for it in items if it["text"] == "Delete me.")
    memory.pin_memory(target["id"], True)

    assert memory.delete_memory(target["id"]) is True

    remaining = memory.list_memories()
    assert [it["text"] for it in remaining] == ["Keep me."]
    assert target["id"] not in set(memory._read_json(memory._OVERLAY, {}).get("pinned", []))


def test_delete_memory_unknown_id_is_a_harmless_noop(mem_env):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Keep me.\n")
    assert memory.delete_memory("deadbeef0000") is True
    assert [it["text"] for it in memory.list_memories()] == ["Keep me."]


# --- pin_memory ----------------------------------------------------------------

def test_pin_memory_add_and_remove_round_trips_through_overlay(mem_env):
    memory.pin_memory("id1", True)
    assert memory._read_json(memory._OVERLAY, {})["pinned"] == ["id1"]

    memory.pin_memory("id2", True)
    assert memory._read_json(memory._OVERLAY, {})["pinned"] == ["id1", "id2"]

    memory.pin_memory("id1", False)
    assert memory._read_json(memory._OVERLAY, {})["pinned"] == ["id2"]


def test_pin_memory_pinning_twice_is_idempotent(mem_env):
    memory.pin_memory("id1", True)
    memory.pin_memory("id1", True)
    assert memory._read_json(memory._OVERLAY, {})["pinned"] == ["id1"]


# --- auto_memory_enabled: prefs read ------------------------------------------

def test_auto_memory_enabled_defaults_true_when_pref_unset(mem_env):
    assert memory.auto_memory_enabled() is True


def test_auto_memory_enabled_false_when_pref_explicitly_false(mem_env):
    memory._write_json(memory._PREFS, {"auto_memory": False})
    assert memory.auto_memory_enabled() is False


def test_auto_memory_enabled_true_when_pref_explicitly_true(mem_env):
    memory._write_json(memory._PREFS, {"auto_memory": True})
    assert memory.auto_memory_enabled() is True


# --- maybe_auto_extract: belt-and-suspenders guard around the whole body ----

@pytest.mark.anyio
@pytest.mark.skipif(os.geteuid() == 0, reason="chmod 000 does not block root")
async def test_maybe_auto_extract_swallows_unreadable_prefs_file(mem_env):
    """auto_memory_enabled() reads _PREFS via _read_json, which deliberately
    raises OSError (e.g. PermissionError) on an unreadable file — see
    test_memory_read_json_raises_on_unreadable_file in
    test_corruption_quarantine.py. maybe_auto_extract is a detached
    background task fired after every web turn; that read used to sit
    OUTSIDE its own try/except Exception guard, so a permission hiccup on
    the prefs file would propagate out of the background task. It's now
    inside the guarded region, so this completes silently instead."""
    memory._write_json(memory._PREFS, {"auto_memory": True})
    os.chmod(memory._PREFS, 0o000)
    try:
        await memory.maybe_auto_extract("some-session-key")  # must not raise
    finally:
        os.chmod(memory._PREFS, 0o600)  # so pytest's tmp cleanup can proceed


# --- routes: thin wiring proof over the already-tested core functions -------

def test_route_get_memory_reflects_file_contents(mem_env, client):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- Existing.\n")
    r = client.get("/api/memory")
    assert r.status_code == 200
    assert [it["text"] for it in r.json()["memory"]] == ["Existing."]


def test_route_post_add_requires_nonempty_text(mem_env, client):
    r = client.post("/api/memory/add", json={"text": "   "})
    assert r.status_code == 400


def test_route_post_add_writes_through_to_disk(mem_env, client):
    r = client.post("/api/memory/add", json={"text": "Added via route."})
    assert r.status_code == 200
    assert r.json()["category"] == memory.USER_SECTION
    assert "- Added via route." in memory.MEMORY_MD.read_text()


def test_route_put_memory_404s_for_unknown_id(mem_env, client):
    r = client.put("/api/memory/deadbeef0000", data={"text": "x"})
    assert r.status_code == 404


def test_route_pin_then_delete(mem_env, client):
    memory.MEMORY_MD.write_text(f"## {memory.USER_SECTION}\n- To pin.\n")
    mid = memory.list_memories()[0]["id"]

    r = client.post(f"/api/memory/{mid}/pin", data={"pinned": "true"})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "pinned": True}
    assert memory.list_memories()[0]["pinned"] is True

    r2 = client.delete(f"/api/memory/{mid}")
    assert r2.status_code == 200
    assert r2.json() == {"ok": True}
    assert memory.list_memories() == []


def test_route_prefs_put_then_get_roundtrip(mem_env, client):
    r = client.put("/api/prefs/auto_memory", json={"value": False})
    assert r.status_code == 200
    assert r.json() == {"ok": True, "key": "auto_memory", "value": False}

    r2 = client.get("/api/prefs/auto_memory")
    assert r2.status_code == 200
    assert r2.json() == {"key": "auto_memory", "value": False}
