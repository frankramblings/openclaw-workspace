"""Shared fixtures: an isolated vault Documents dir + a doc factory.

backend.documents computes DOCS_DIR/VERSIONS_DIR at import time from the real
vault; its helpers read the module globals at call time, so monkeypatching the
two globals redirects every read/write/snapshot into tmp_path."""
import pytest

from backend import config, documents, sessions_store


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Keep every test away from the live .data/ store. Route tests used to
    write REAL session records into .data/sessions.json (~100 junk 'Q about
    quotas' sessions accumulated in the user's sidebar), and the leftovers
    made the spinoff-dedupe test fail forever after. _STORE_FILE is computed
    at import so patch the module global; spinoff.log and friends resolve
    config.DATA_DIR at call time so patching the config global covers them.
    Tests that point these at their own tmp paths simply override this."""
    monkeypatch.setattr(sessions_store, "_STORE_FILE", tmp_path / "sessions.json")
    monkeypatch.setattr(config, "DATA_DIR", tmp_path / "data")


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
