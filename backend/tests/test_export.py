"""GET /api/export: a real zip of sessions/notes/documents/memory.

Every store this route reads is monkeypatched into tmp_path (the autouse
_isolated_data_dir fixture in conftest.py already covers config.DATA_DIR /
sessions_store._STORE_FILE; notes.NOTES_DIR, documents.DOCS_DIR, and
memory.MEMORY_MD/_OVERLAY/_PREFS are patched directly here, same rationale as
test_memory.py's mem_env fixture — those modules bind their paths at import
time from a different base (the vault / config.OPENCLAW_HOME), so the
autouse DATA_DIR patch alone doesn't reach them) so this test never touches
Frank's real ~/.openclaw vault or .data/ store.
"""
from __future__ import annotations

import io
import json
import zipfile

import pytest
from fastapi.testclient import TestClient

from backend import documents, export_route, memory, notes, sessions_store
from backend.app import app

client = TestClient(app)


@pytest.fixture
def export_env(tmp_path, monkeypatch):
    monkeypatch.setattr(sessions_store, "_STORE_FILE", tmp_path / "sessions.json")
    monkeypatch.setattr(notes, "NOTES_DIR", tmp_path / "Notes")
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path / "Documents")
    monkeypatch.setattr(documents, "VERSIONS_DIR", tmp_path / "Documents" / ".versions")
    monkeypatch.setattr(memory, "MEMORY_MD", tmp_path / "MEMORY.md")
    monkeypatch.setattr(memory, "_OVERLAY", tmp_path / "memory_overlay.json")
    monkeypatch.setattr(memory, "_PREFS", tmp_path / "memory_prefs.json")
    return tmp_path


def _zip_from(res) -> zipfile.ZipFile:
    return zipfile.ZipFile(io.BytesIO(res.content))


def test_export_200_zip_even_when_nothing_exists(export_env):
    """No sessions/notes/documents/memory written yet — must not 500."""
    res = client.get("/api/export")
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/zip"
    zf = _zip_from(res)
    assert zf.namelist() == []  # nothing to include, but a valid empty zip


def test_export_content_disposition_filename(export_env):
    res = client.get("/api/export")
    cd = res.headers.get("content-disposition", "")
    assert "attachment" in cd
    assert "openclaw-backup-" in cd
    assert cd.rstrip('"').endswith(".zip")


def test_export_bundles_sessions_notes_documents_memory(export_env):
    tmp_path = export_env

    sessions_store._STORE_FILE.write_text(json.dumps({"sessions": [{"id": "s1"}]}))

    notes.NOTES_DIR.mkdir(parents=True)
    (notes.NOTES_DIR / "note1.md").write_text("---\ntitle: \"Test\"\n---\nHello note.\n")

    documents.DOCS_DIR.mkdir(parents=True)
    (documents.DOCS_DIR / "doc1.md").write_text("---\ntitle: \"Doc\"\n---\nHello doc.\n")
    (documents.VERSIONS_DIR / "doc1").mkdir(parents=True)
    (documents.VERSIONS_DIR / "doc1" / "v1.md").write_text("old version")

    memory.MEMORY_MD.write_text("## User Notes\n- A fact.\n")
    memory._write_json(memory._OVERLAY, {"pinned": ["abc"]})
    memory._write_json(memory._PREFS, {"auto_memory": True})

    res = client.get("/api/export")
    assert res.status_code == 200
    zf = _zip_from(res)
    names = set(zf.namelist())
    assert names == {
        "sessions.json",
        "notes/note1.md",
        "documents/doc1.md",
        "documents/.versions/doc1/v1.md",
        "memory/MEMORY.md",
        "memory/memory_overlay.json",
        "memory/memory_prefs.json",
    }
    assert json.loads(zf.read("sessions.json")) == {"sessions": [{"id": "s1"}]}
    assert zf.read("notes/note1.md").decode() == "---\ntitle: \"Test\"\n---\nHello note.\n"
    assert zf.read("documents/.versions/doc1/v1.md").decode() == "old version"
    assert "A fact." in zf.read("memory/MEMORY.md").decode()
    assert json.loads(zf.read("memory/memory_overlay.json")) == {"pinned": ["abc"]}


def test_export_is_read_only(export_env):
    """The whole point of a backup export: it must never create or modify
    anything it reads. Snapshot the (empty) tree before/after and diff."""
    tmp_path = export_env
    before = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))

    res = client.get("/api/export")
    assert res.status_code == 200

    after = sorted(p.relative_to(tmp_path) for p in tmp_path.rglob("*"))
    assert before == after


def test_build_zip_skips_unreadable_file_instead_of_raising(export_env, monkeypatch):
    """A single bad file (permission error, race with a concurrent writer)
    must not sink the whole export."""
    sessions_store._STORE_FILE.write_text("{}")

    def boom(self, filename, arcname=None, *a, **kw):
        raise OSError("simulated read failure")

    monkeypatch.setattr(zipfile.ZipFile, "write", boom)
    # _build_zip runs synchronously; call it directly to assert it degrades
    # gracefully rather than raising through the route.
    data = export_route._build_zip()
    zf = zipfile.ZipFile(io.BytesIO(data))
    assert zf.namelist() == []
