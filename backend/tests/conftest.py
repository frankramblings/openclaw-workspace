"""Shared fixtures: an isolated vault Documents dir + a doc factory.

backend.documents computes DOCS_DIR/VERSIONS_DIR at import time from the real
vault; its helpers read the module globals at call time, so monkeypatching the
two globals redirects every read/write/snapshot into tmp_path."""
import pytest

from backend import changes, config, documents, notes, projects_store, sessions_store, vault_store as vs


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Keep every test away from the live .data/ store. Route tests used to
    write REAL session records into .data/sessions.json (~100 junk 'Q about
    quotas' sessions accumulated in the user's sidebar), and the leftovers
    made the spinoff-dedupe test fail forever after. _STORE_FILE is computed
    at import so patch the module global; spinoff.log and friends resolve
    config.DATA_DIR at call time so patching the config global covers them.
    Tests that point these at their own tmp paths simply override this.

    backend.changes needs the same treatment now that chat_turn's recorder
    calls it for real on every turn (Task 5): DEFAULT_CONFIG["roots"] lists
    Frank's actual home-directory paths, and _ACTIVE is a plain module-level
    dict, not scoped by DATA_DIR. Left alone, any route test that drives a
    real (unmocked) turn would refresh_index() those real directories, and a
    turn whose changes.turn_ended never runs (the detached changes_end_later
    task gets cancelled when a test's short-lived event loop closes before
    its 1.5s settle delay elapses) leaves a stale entry in _ACTIVE that makes
    an unrelated later test's turn look 'shared' with a turn that has nothing
    to do with it. Tests that want real scanning already pass their own
    roots via changes.load_config/_use_root, so they're unaffected."""
    monkeypatch.setattr(sessions_store, "_STORE_FILE", tmp_path / "sessions.json")
    monkeypatch.setattr(projects_store, "_STORE_FILE", tmp_path / "projects.json")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")
    monkeypatch.setattr(changes, "DEFAULT_CONFIG", {**changes.DEFAULT_CONFIG, "roots": []})
    monkeypatch.setattr(changes, "_ACTIVE", {})


@pytest.fixture
def vault_docs(tmp_path, monkeypatch):
    docs_dir = tmp_path / "Documents"
    monkeypatch.setattr(documents, "DOCS_DIR", docs_dir)
    monkeypatch.setattr(documents, "VERSIONS_DIR", docs_dir / ".versions")

    def make(body="# Hello\n\nFirst draft.\n", **meta):
        doc = {
            "id": "abc123def456", "title": "Test Doc", "language": "markdown",
            "session_id": "sess1", "session_name": "Chat",
            "version_count": 1, "is_active": True, "archived": False,
            "created": "2026-06-01T00:00:00+00:00",
            "updated_at": "2026-06-01T00:00:00+00:00",
            "current_content": body,
        }
        doc.update(meta)
        return documents._write(doc)

    return make


@pytest.fixture
def vault_notes(tmp_path, monkeypatch):
    notes_dir = tmp_path / "Notes"
    monkeypatch.setattr(notes, "NOTES_DIR", notes_dir)

    def make(note_id="note1", title="Test Note", body="Hello note body.\n", **meta):
        entry = {"id": note_id, "title": title,
                  "created": "2026-06-01T00:00:00+00:00",
                  "updated": "2026-06-01T00:00:00+00:00", "archived": False}
        entry.update(meta)
        vs.save_entry(notes._path(note_id), entry, body)
        entry["content"] = body
        return entry

    return make
