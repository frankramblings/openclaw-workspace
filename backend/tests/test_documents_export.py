"""Export endpoint: pandoc-rendered .docx with honest 404/400/501 paths."""
import shutil

import pytest
from fastapi.testclient import TestClient

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
    doc = vault_docs()
    monkeypatch.setattr(shutil, "which", lambda _name: None)
    res = client.get(f"/api/document/{doc['id']}/export?format=docx")
    assert res.status_code == 501
    assert "pandoc" in res.json()["error"]


@pytest.mark.skipif(shutil.which("pandoc") is None, reason="pandoc not installed")
def test_export_docx_roundtrip(vault_docs):
    doc = vault_docs(body="# Title\n\n- bullet one\n- bullet two\n")
    res = client.get(f"/api/document/{doc['id']}/export?format=docx")
    assert res.status_code == 200
    assert res.content[:2] == b"PK"  # docx is a zip
    assert "Test Doc.docx" in res.headers.get("content-disposition", "")
