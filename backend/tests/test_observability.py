"""Task 13 — minimal observability: logged swallows + honest route-boundary
errors on a vault/document write failure.

Three things this task added that weren't covered by any existing test:
  1. A previously-silent swallow now logs a WARNING with a traceback
     (event_store.append's dead-subscriber-queue catch).
  2. The chat_stream turn-close `finally` still never breaks a turn on a
     sessions_store.update failure, but now logs it.
  3. A vault/document write failure (fsutil.atomic_write_text raising, per
     Task 10) surfaces as a logged, honest {"error": "write failed"} 500 at
     the Notes/Documents route boundary instead of an unhandled crash or
     (pre-Task-10) a silent 200 that didn't actually persist anything.

Note on "monkeypatch fsutil.atomic_write_text": vault_store.py imports it by
name (`from .fsutil import atomic_write_text`), so patching the function on
the `fsutil` module itself does not reach `vault_store.save_entry` (it kept
its own bound reference at import time). The tests below patch
`vault_store.atomic_write_text` — the binding `save_entry` actually calls —
which is the effective equivalent for every caller that goes through it
(notes.py, documents.py)."""
from __future__ import annotations

import logging

from fastapi.testclient import TestClient

from backend import app as app_module
from backend import bridge, documents, event_store, notes, sessions_store, vault_store
from backend.app import app

client = TestClient(app)


# --- event_store.append: dead-subscriber-queue swallow now logs -------------

def test_append_logs_warning_when_subscriber_queue_put_fails(caplog):
    session_key = "test-session-append-swallow"
    q = event_store.subscribe(session_key)
    try:
        def _boom(_item):
            raise RuntimeError("queue closed")

        q.put_nowait = _boom  # simulate a full/closed subscriber queue
        with caplog.at_level(logging.WARNING, logger="backend.event_store"):
            seq = event_store.append(session_key, "data: {}\n\n")
        # Swallow semantics preserved: append itself still succeeds.
        assert seq == "1"
        assert any(
            r.name == "backend.event_store" and r.levelno == logging.WARNING
            and r.exc_info is not None
            for r in caplog.records
        )
    finally:
        event_store.unsubscribe(session_key, q)
        event_store.drop_session(session_key)


# --- chat_stream turn-close finally: sessions_store.update swallow logs -----

def test_chat_stream_logs_sessions_store_update_failure_but_still_completes(
        monkeypatch, caplog):
    """A real (non-placeholder) title means _needs_title is False, so this
    exercises exactly the "touch the updated stamp" swallow in _drive_turn's
    finally — not the separate AI-title swallow — in isolation."""
    rec = sessions_store.create(name="Real chat title")

    async def fake_stream_turn(message, session_key=None, model_ref=None,
                               run_info=None, **kwargs):
        yield bridge._sse({"delta": "hi"})
        yield bridge._sse("[DONE]")

    async def fake_extract(session_key):
        return None

    def _boom(*a, **kw):
        raise OSError("disk full")

    monkeypatch.setattr(bridge, "stream_turn", fake_stream_turn)
    monkeypatch.setattr(app_module, "maybe_auto_extract", fake_extract)
    monkeypatch.setattr(sessions_store, "update", _boom)

    with caplog.at_level(logging.WARNING, logger="backend.app"):
        res = client.post("/api/chat_stream",
                          data={"message": "hello", "session": rec["id"]})

    # Never breaks the turn: still 200, still reaches [DONE].
    assert res.status_code == 200
    assert "[DONE]" in res.text
    assert any(
        r.name == "backend.app" and r.levelno == logging.WARNING
        and r.exc_info is not None and "sessions_store.update" in r.getMessage()
        for r in caplog.records
    )


# --- Notes/Documents route boundary: a write failure is now a logged 500 ---

def test_create_note_returns_500_and_logs_on_vault_write_failure(
        tmp_path, monkeypatch, caplog):
    monkeypatch.setattr(notes, "NOTES_DIR", tmp_path / "Notes")

    def _boom(_path, _text):
        raise OSError("disk full")

    monkeypatch.setattr(vault_store, "atomic_write_text", _boom)

    with caplog.at_level(logging.ERROR, logger="backend.notes"):
        r = client.post("/api/notes", json={"title": "x", "content": "y"})

    assert r.status_code == 500
    assert r.json() == {"error": "write failed"}
    assert any(rec.name == "backend.notes" and rec.exc_info is not None
               for rec in caplog.records)
    # And nothing was left behind claiming to be saved.
    assert list((tmp_path / "Notes").glob("*.md")) == []


def test_create_document_returns_500_and_logs_on_vault_write_failure(
        vault_docs, monkeypatch, caplog):
    def _boom(_path, _text):
        raise OSError("disk full")

    monkeypatch.setattr(vault_store, "atomic_write_text", _boom)

    with caplog.at_level(logging.ERROR, logger="backend.documents"):
        r = client.post("/api/document",
                        json={"title": "x", "content": "y"})

    assert r.status_code == 500
    assert r.json() == {"error": "write failed"}
    assert any(rec.name == "backend.documents" and rec.exc_info is not None
               for rec in caplog.records)
    assert list(documents.DOCS_DIR.glob("*.md")) == []


def test_save_document_snapshot_failure_also_returns_500(vault_docs, monkeypatch, caplog):
    """The version-snapshot write (taken before the new body overwrites the
    file) is guarded the same way as the main write — a failure there must
    not silently proceed to overwrite the doc with no undo point saved."""
    doc = vault_docs()

    def _boom(_path, _text):
        raise OSError("disk full")

    monkeypatch.setattr(vault_store, "atomic_write_text", _boom)

    with caplog.at_level(logging.ERROR, logger="backend.documents"):
        r = client.put(f"/api/document/{doc['id']}", json={"content": "changed"})

    assert r.status_code == 500
    assert r.json() == {"error": "write failed"}
    # The doc on disk must be untouched (still the original body/version).
    on_disk = documents._load(doc["id"])
    assert on_disk["current_content"] == doc["current_content"]
    assert on_disk["version_count"] == 1
