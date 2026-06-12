"""The vault list endpoints must do their disk scans off the event loop.

Pins (a) the _scan_docs helper exists and loads entries, and (b) the routes
still return the same shapes after the asyncio.to_thread refactor.
"""
import asyncio

from backend import documents, notes
from backend import vault_store as vs


def _write_doc(dirpath, doc_id, title, session_id="", archived=False):
    meta = {"id": doc_id, "title": title, "language": "markdown",
            "session_id": session_id, "archived": archived,
            "is_active": True, "version_count": 1,
            "created": vs.now_iso(), "updated_at": vs.now_iso()}
    vs.save_entry(dirpath / f"{doc_id}.md", meta, f"body of {title}")


def test_scan_docs_loads_entries(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path)
    _write_doc(tmp_path, "d1", "Alpha")
    _write_doc(tmp_path, "d2", "Beta", session_id="s9")
    got = documents._scan_docs()
    assert {d["id"] for d in got} == {"d1", "d2"}
    assert all(d["current_content"].startswith("body of ") for d in got)


def test_library_shape_unchanged(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path)
    _write_doc(tmp_path, "d1", "Alpha")
    _write_doc(tmp_path, "d2", "Zulu", archived=True)
    resp = asyncio.run(documents.library())
    assert resp["total"] == 1
    assert resp["documents"][0]["title"] == "Alpha"
    assert "preview" in resp["documents"][0]


def test_list_session_docs_filters(tmp_path, monkeypatch):
    monkeypatch.setattr(documents, "DOCS_DIR", tmp_path)
    _write_doc(tmp_path, "d1", "Alpha", session_id="s9")
    _write_doc(tmp_path, "d2", "Beta", session_id="other")
    got = asyncio.run(documents.list_session_docs("s9"))
    assert [d["id"] for d in got] == ["d1"]


def test_list_notes_shape(tmp_path, monkeypatch):
    monkeypatch.setattr(notes, "NOTES_DIR", tmp_path)
    vs.save_entry(tmp_path / "n1.md",
                  {"id": "n1", "pinned": False, "archived": False,
                   "created": vs.now_iso(), "updated": vs.now_iso()},
                  "hello")
    resp = asyncio.run(notes.list_notes())
    assert [n["id"] for n in resp["notes"]] == ["n1"]
