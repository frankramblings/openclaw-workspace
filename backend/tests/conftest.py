"""Shared fixtures: an isolated vault Documents dir + a doc factory.

backend.documents computes DOCS_DIR/VERSIONS_DIR at import time from the real
vault; its helpers read the module globals at call time, so monkeypatching the
two globals redirects every read/write/snapshot into tmp_path."""
import pytest

from backend import documents


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
