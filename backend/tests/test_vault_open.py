"""Vault-file links: GET /api/vault/open wraps any vault .md as a library doc
(two-way: edits to the doc mirror back to the file; reopen refreshes from disk)."""
import os
from pathlib import Path

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
    # 2026-06-10: ANY vault text file opens — extension is only a language
    # hint. Gates are UTF-8 decodability and the EDITOR_MAX_BYTES ceiling.
    vault("memory/data.txt", "plain text body")
    res = client.get("/api/vault/open?path=memory/data.txt")
    assert res.status_code == 200
    doc = res.json()
    assert doc["language"] == "text"
    assert doc["title"] == "data.txt"          # non-md keeps its extension
    # .bak wrappers take their language from the inner extension.
    vault("memory/old-notes.md.bak", "backup body")
    res = client.get("/api/vault/open?path=memory/old-notes.md.bak")
    assert res.status_code == 200
    assert res.json()["language"] == "markdown"
    assert res.json()["title"] == "old-notes.md.bak"
    # Unknown extensions — even none at all — open as plain text.
    vault("memory/NOTES", "extensionless but text")
    res = client.get("/api/vault/open?path=memory/NOTES")
    assert res.status_code == 200
    assert res.json()["language"] == "text"
    # Actual binary content refuses (explorer falls back to preview)...
    binpath = vault("memory/blob.bin", "x")
    binpath.write_bytes(b"\x00\xff\xfe binary \x00")
    assert client.get("/api/vault/open?path=memory/blob.bin").status_code == 400
    # ...as does anything over the size ceiling.
    bigpath = vault("memory/huge.log", "x")
    bigpath.write_text("y" * (2 * 1024 * 1024 + 1), encoding="utf-8")
    assert client.get("/api/vault/open?path=memory/huge.log").status_code == 400
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


def test_extra_root_open_edit_and_reject(tmp_path, monkeypatch, vault_docs):
    """Files under ALLOWED_EXTRA_ROOTS open and mirror edits back to disk;
    files outside every root return 400."""
    monkeypatch.setattr(vs, "WORKSPACE", tmp_path / "workspace")
    (tmp_path / "workspace").mkdir()
    extra = tmp_path / "extra-root"
    extra.mkdir()
    outside = tmp_path / "off-limits"
    outside.mkdir()
    monkeypatch.setattr(documents, "ALLOWED_EXTRA_ROOTS", [extra])

    f = extra / "sub" / "note.md"
    f.parent.mkdir(parents=True)
    f.write_text("hello from extra\n", encoding="utf-8")

    res = client.get(f"/api/vault/open?path={f}")
    assert res.status_code == 200
    doc = res.json()
    assert doc["vault_path"] == str(f.resolve())
    assert doc["title"] == "note"
    assert doc["language"] == "markdown"
    assert "hello from extra" in doc["current_content"]

    # Edits mirror back to disk.
    res = client.put(f"/api/document/{doc['id']}", json={"content": "edited\n"})
    assert res.status_code == 200
    assert f.read_text(encoding="utf-8") == "edited\n"

    # Reopen reuses the wrapper and picks up on-disk changes.
    f.write_text("changed on disk\n", encoding="utf-8")
    second = client.get(f"/api/vault/open?path={f}").json()
    assert second["id"] == doc["id"]
    assert "changed on disk" in second["current_content"]

    # Files outside every allowed root are rejected.
    bad = outside / "secret.md"
    bad.write_text("nope", encoding="utf-8")
    assert client.get(f"/api/vault/open?path={bad}").status_code == 400

    # Symlink escape doesn't count — a link inside the root pointing outside
    # resolves out and is rejected.
    link = extra / "escape.md"
    link.symlink_to(bad)
    assert client.get(f"/api/vault/open?path={link}").status_code == 400


def test_open_documents_path_returns_real_doc(vault, vault_docs):
    doc = vault_docs()
    res = client.get(f"/api/vault/open?path=Documents/{doc['id']}.md")
    assert res.status_code == 200
    assert res.json()["id"] == doc["id"]
    assert "vault_path" not in res.json()
