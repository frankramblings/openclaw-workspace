"""Export endpoint: pandoc-rendered .docx with honest 404/400/501 paths."""

import pytest
from fastapi.testclient import TestClient

from backend import documents
from backend.app import app

client = TestClient(app)


def test_export_unknown_doc_404(vault_docs):
    res = client.get("/api/document/zzzzzz/export?format=docx")
    assert res.status_code == 404


def test_export_unsupported_format_400(vault_docs):
    doc = vault_docs()
    res = client.get(f"/api/document/{doc['id']}/export?format=odt")
    assert res.status_code == 400


def test_export_without_pandoc_501(vault_docs, monkeypatch):
    import backend.documents as docs_mod
    doc = vault_docs()
    # Patch the module-level helper so the 501 path is reached regardless of
    # whether /usr/local/bin/pandoc happens to exist on this machine.
    monkeypatch.setattr(docs_mod, "_find_pandoc", lambda: None)
    res = client.get(f"/api/document/{doc['id']}/export?format=docx")
    assert res.status_code == 501
    assert "pandoc" in res.json()["error"]


@pytest.mark.skipif(documents._find_pandoc() is None, reason="pandoc not installed")
def test_export_docx_roundtrip(vault_docs):
    doc = vault_docs(body="# Title\n\n- bullet one\n- bullet two\n")
    res = client.get(f"/api/document/{doc['id']}/export?format=docx")
    assert res.status_code == 200
    assert res.content[:2] == b"PK"  # docx is a zip
    # Starlette emits the RFC 5987 form: filename*=utf-8''Test%20Doc.docx
    assert "Test%20Doc.docx" in res.headers.get("content-disposition", "")
