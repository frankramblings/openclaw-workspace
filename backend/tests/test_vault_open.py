"""Vault-file links: GET /api/vault/open wraps any vault .md as a library doc
(two-way: edits to the doc mirror back to the file; reopen refreshes from disk)."""
import os

import pytest
from fastapi.testclient import TestClient

from backend import documents, vault_store as vs
from backend.app import app

client = TestClient(app)


@pytest.fixture
def vault(tmp_path, monkeypatch, vault_docs):
    """vault_docs isolation + the vault root itself redirected to tmp_path."""
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path)

    def make_file(rel, body="# Radar\n\nWeek ahead.\n"):
        p = tmp_path / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(body, encoding="utf-8")
        return p

    return make_file


def test_vault_rel_confines_and_normalizes(vault):
    home_abs = os.path.expanduser("~/.openclaw/workspace/memory/a.md")
    assert documents._vault_rel(home_abs) == "memory/a.md"
    assert documents._vault_rel("~/.openclaw/workspace/memory/a.md") == "memory/a.md"
    assert documents._vault_rel("memory/a.md") == "memory/a.md"
    assert documents._vault_rel("../outside.md") is None
    assert documents._vault_rel("memory/../../etc/passwd") is None
    assert documents._vault_rel("/etc/passwd") is None


def test_open_creates_wrapper_doc(vault):
    vault("memory/proactive-drafts/party.md")
    res = client.get("/api/vault/open?path=memory/proactive-drafts/party.md")
    assert res.status_code == 200
    doc = res.json()
    assert doc["vault_path"] == "memory/proactive-drafts/party.md"
    assert doc["title"] == "party"
    assert "Week ahead." in doc["current_content"]


def test_open_missing_or_incompatible(vault):
    assert client.get("/api/vault/open?path=memory/nope.md").status_code == 404
    # 2026-06-10: editor-compatible text types beyond .md open too (the
    # workspace explorer routes them to the document editor).
    vault("memory/data.txt", "plain text body")
    res = client.get("/api/vault/open?path=memory/data.txt")
    assert res.status_code == 200
    doc = res.json()
    assert doc["language"] == "text"
    assert doc["title"] == "data.txt"          # non-md keeps its extension
    # .bak wrappers resolve by their inner extension: text backups open...
    vault("memory/old-notes.md.bak", "backup body")
    res = client.get("/api/vault/open?path=memory/old-notes.md.bak")
    assert res.status_code == 200
    assert res.json()["language"] == "markdown"
    assert res.json()["title"] == "old-notes.md.bak"
    # ...binary-ish backups (unknown inner ext) don't.
    vault("memory/state.sqlite.bak", "x")
    assert client.get("/api/vault/open?path=memory/state.sqlite.bak").status_code == 400
    # Unknown/binary extensions still refuse (explorer falls back to preview).
    vault("memory/blob.bin", "x")
    assert client.get("/api/vault/open?path=memory/blob.bin").status_code == 400
    assert client.get("/api/vault/open?path=../escape.md").status_code == 400


def test_reopen_reuses_wrapper_and_refreshes_from_disk(vault):
    f = vault("memory/radar.md", "v1 body\n")
    first = client.get("/api/vault/open?path=memory/radar.md").json()
    # Agent (or anything) edits the file directly:
    f.write_text("v2 body\n", encoding="utf-8")
    second = client.get("/api/vault/open?path=memory/radar.md").json()
    assert second["id"] == first["id"]          # reused, not duplicated
    assert "v2 body" in second["current_content"]
    assert second["version_count"] == first["version_count"] + 1


def test_doc_save_mirrors_back_to_vault_file(vault):
    f = vault("memory/radar.md", "original\n")
    doc = client.get("/api/vault/open?path=memory/radar.md").json()
    res = client.put(f"/api/document/{doc['id']}", json={"content": "edited in UI\n"})
    assert res.status_code == 200
    assert f.read_text(encoding="utf-8") == "edited in UI\n"


def test_open_documents_path_returns_real_doc(vault, vault_docs):
    doc = vault_docs()
    res = client.get(f"/api/vault/open?path=Documents/{doc['id']}.md")
    assert res.status_code == 200
    assert res.json()["id"] == doc["id"]
    assert "vault_path" not in res.json()
