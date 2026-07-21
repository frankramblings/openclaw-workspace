"""Tests for backend.palette module: cross-source lexical search."""
from __future__ import annotations

import json
from pathlib import Path
from unittest import mock
import asyncio

import pytest
from fastapi.testclient import TestClient

from backend import config, palette
from backend.app import app

pytest_plugins = ("pytest_asyncio",)


@pytest.fixture
def mock_data_dir(tmp_path, monkeypatch):
    """Point DATA_DIR to a temp directory for isolation."""
    test_data_dir = tmp_path / "data"
    test_data_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "DATA_DIR", test_data_dir)
    return test_data_dir


@pytest.fixture
def client(mock_data_dir):
    """FastAPI TestClient for endpoint testing."""
    with TestClient(app, raise_server_exceptions=True) as c:
        yield c


class TestRankAndSnippet:
    """Test the ranking and snippet extraction logic."""

    def test_title_prefix_match(self):
        """Title prefix match gets rank 0 (highest)."""
        item = {"name": "Python tutorial", "content": ""}
        rank, snippet = palette._rank_and_snippet("python", "session", item)
        assert rank == palette.RANK_TITLE_PREFIX
        assert snippet == "python tutorial"

    def test_title_substring_match(self):
        """Title substring (not prefix) gets rank 1."""
        item = {"title": "Advanced Python Tricks"}
        rank, snippet = palette._rank_and_snippet("python", "note", item)
        assert rank == palette.RANK_TITLE_SUBSTR
        assert "python" in snippet.lower()

    def test_content_substring_match(self):
        """Content substring gets rank 2 (lowest)."""
        item = {
            "title": "Notes",
            "content": "This is a long document about something else, but it mentions python somewhere deep in the text."
        }
        rank, snippet = palette._rank_and_snippet("python", "note", item)
        assert rank == palette.RANK_CONTENT_SUBSTR
        assert "python" in snippet.lower()

    def test_no_match_returns_none(self):
        """No match returns None."""
        item = {"title": "Something", "content": "Else"}
        result = palette._rank_and_snippet("xyz", "note", item)
        assert result is None

    def test_case_insensitive_matching(self):
        """Matching is case-insensitive."""
        item = {"name": "PYTHON Tutorial"}
        rank, snippet = palette._rank_and_snippet("python", "session", item)
        assert rank == palette.RANK_TITLE_PREFIX

    def test_email_subject_matching(self):
        """Email subjects are matched like titles."""
        item = {
            "subject": "Meeting tomorrow at 3pm",
            "snippet": "This is the email body"
        }
        rank, snippet = palette._rank_and_snippet("meeting", "email", item)
        assert rank == palette.RANK_TITLE_PREFIX

    def test_document_matching(self):
        """Documents match on title and current_content."""
        item = {
            "title": "Design Document",
            "current_content": "This describes the system architecture."
        }
        rank, snippet = palette._rank_and_snippet("design", "document", item)
        assert rank == palette.RANK_TITLE_PREFIX


@pytest.mark.asyncio
async def test_search_empty_query_returns_recent_sessions():
    """Empty query returns recent sessions sorted by creation time."""
    mock_sessions = [
        {"id": "s1", "name": "Session 1", "created": 1000},
        {"id": "s2", "name": "Session 2", "created": 2000},
        {"id": "s3", "name": "Session 3", "created": 1500},
    ]

    with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
        with mock.patch("backend.palette._load_notes", return_value=[]):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("", limit=10)

    assert len(results) == 3
    assert results[0]["id"] == "s2"  # Created at 2000 (newest)
    assert results[1]["id"] == "s3"  # Created at 1500
    assert results[2]["id"] == "s1"  # Created at 1000 (oldest)


@pytest.mark.asyncio
async def test_search_query_ranks_results():
    """Search results are ranked by tier then recency."""
    mock_sessions = [
        {"id": "s1", "name": "Python for Beginners", "created": 1000},
    ]
    mock_notes = [
        {"id": "n1", "title": "Python Notes", "content": "Learning Python", "updated": 2000, "archived": False},
        {"id": "n2", "title": "Other", "content": "This mentions python here", "updated": 1500, "archived": False},
    ]

    with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
        with mock.patch("backend.palette._load_notes", return_value=mock_notes):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("python", limit=10)

    # Should rank by tier: title-prefix > title-substr > content-substr
    # Then by recency within each tier
    assert len(results) == 3
    # Both session and n1 have title-prefix (rank 0), sorted by recency
    # n1 has updated=2000, session has created=1000, so n1 comes first
    assert results[0]["kind"] == "note"  # Title prefix, most recent
    assert results[1]["kind"] == "session"  # Title prefix, older
    assert results[2]["kind"] == "note"  # Content substring


@pytest.mark.asyncio
async def test_search_respects_limit():
    """Search results are capped at the limit."""
    mock_sessions = [
        {"id": f"s{i}", "name": f"Session {i}", "created": i} for i in range(100)
    ]

    with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
        with mock.patch("backend.palette._load_notes", return_value=[]):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("", limit=20)

    assert len(results) == 20


@pytest.mark.asyncio
async def test_search_filters_archived_items():
    """Archived notes and documents are excluded."""
    mock_notes = [
        {"id": "n1", "title": "Active Note", "updated": 1000, "archived": False},
        {"id": "n2", "title": "Archived Note", "updated": 2000, "archived": True},
    ]
    mock_docs = [
        {"id": "d1", "title": "Active Doc", "updated_at": 1000, "archived": False},
        {"id": "d2", "title": "Archived Doc", "updated_at": 2000, "archived": True},
    ]

    with mock.patch("backend.palette._load_sessions", return_value=[]):
        with mock.patch("backend.palette._load_notes", return_value=mock_notes):
            with mock.patch("backend.palette._load_docs", return_value=mock_docs):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("active", limit=10)

    # Should only have 2 results (the active ones)
    assert len(results) == 2
    assert all(r["title"] == "Active Note" or r["title"] == "Active Doc" for r in results)


@pytest.mark.asyncio
async def test_search_dedupes_results():
    """Same item shouldn't appear twice (unlikely but test for robustness)."""
    mock_sessions = [
        {"id": "s1", "name": "Python Sessions", "created": 1000},
    ]

    with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
        with mock.patch("backend.palette._load_notes", return_value=[]):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("python", limit=10)

    # Should have exactly one session result
    session_results = [r for r in results if r["kind"] == "session"]
    assert len(session_results) == 1


@pytest.mark.asyncio
async def test_search_query_too_long():
    """Queries longer than 200 chars raise ValueError."""
    long_query = "a" * 201

    with mock.patch("backend.palette._load_sessions", return_value=[]):
        with mock.patch("backend.palette._load_notes", return_value=[]):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    with pytest.raises(ValueError, match="too long"):
                        await palette.search(long_query)


@pytest.mark.asyncio
async def test_search_source_failure_degrades():
    """If one source fails, others still return results."""
    mock_sessions = [
        {"id": "s1", "name": "Python Session", "created": 1000},
    ]

    # Simulate notes module failing by making _load_all raise
    with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
        with mock.patch("backend.notes._load_all", side_effect=Exception("DB error")):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("python", limit=10)

    # Should still get the session result, notes failure degraded gracefully
    assert len(results) == 1
    assert results[0]["kind"] == "session"


@pytest.mark.asyncio
async def test_search_item_level_failure_degrades():
    """A malformed item within a source (e.g. content=None) must not crash
    the whole search — it's skipped, other items/sources still return."""
    mock_notes = [
        {"id": "n1", "title": "Ok title", "content": None, "updated": 1, "archived": False},
        {"id": "n2", "title": "title match two", "content": "has title match content", "updated": 2, "archived": False},
    ]

    with mock.patch("backend.palette._load_sessions", return_value=[]):
        with mock.patch("backend.palette._load_notes", return_value=mock_notes):
            with mock.patch("backend.palette._load_docs", return_value=[]):
                with mock.patch("backend.palette._load_email_async", return_value=[]):
                    results = await palette.search("title", limit=10)

    # The malformed item (n1) is silently dropped; the well-formed one (n2)
    # still matches and is returned. No exception propagates.
    assert len(results) == 1
    assert results[0]["id"] == "n2"


@pytest.mark.asyncio
async def test_load_email_async_never_touches_network():
    """The email source must do zero network I/O from the keystroke path.
    There is no local email cache in this codebase (email_himalaya.py is a
    live proxy over himalaya_cli -> IMAP), so _load_email_async is a no-op
    stub — verify it never reaches the himalaya subprocess layer."""
    with mock.patch(
        "backend.himalaya_cli.run_raw",
        side_effect=AssertionError("network I/O attempted from palette keystroke path"),
    ) as m:
        result = await palette._load_email_async()

    assert result == []
    assert not m.called


class TestPaletteRoute:
    """Test the /api/palette HTTP endpoint."""

    def test_palette_empty_query(self, client):
        """GET /api/palette with no query returns recent sessions."""
        response = client.get("/api/palette")
        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert isinstance(data["results"], list)

    def test_palette_with_query(self, client):
        """GET /api/palette with a query returns results."""
        # Mock the load functions to return test data
        mock_sessions = [{"id": "test1", "name": "Python Tutorial", "created": 1000}]

        with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
            with mock.patch("backend.palette._load_notes", return_value=[]):
                with mock.patch("backend.palette._load_docs", return_value=[]):
                    with mock.patch("backend.palette._load_email_async", return_value=[]):
                        response = client.get("/api/palette?q=python")

        assert response.status_code == 200
        data = response.json()
        assert "results" in data
        assert len(data["results"]) == 1

    def test_palette_query_too_long(self, client):
        """GET /api/palette with a >200 char query returns 400."""
        long_query = "a" * 201
        response = client.get(f"/api/palette?q={long_query}")
        assert response.status_code == 400
        data = response.json()
        assert "error" in data

    def test_palette_limit_parameter(self, client):
        """GET /api/palette respects the limit parameter."""
        response = client.get("/api/palette?limit=5")
        assert response.status_code == 200
        data = response.json()
        # Should not have more than 5 results (might have fewer if data doesn't exist)
        assert len(data["results"]) <= 5

    def test_palette_result_shape(self, client):
        """Palette results have the correct shape."""
        # Mock test data
        mock_sessions = [
            {"id": "s1", "name": "Test Session", "created": 1000}
        ]

        with mock.patch("backend.palette._load_sessions", return_value=mock_sessions):
            with mock.patch("backend.palette._load_notes", return_value=[]):
                with mock.patch("backend.palette._load_docs", return_value=[]):
                    with mock.patch("backend.palette._load_email_async", return_value=[]):
                        response = client.get("/api/palette?q=test")

        assert response.status_code == 200
        data = response.json()
        assert len(data["results"]) > 0

        result = data["results"][0]
        assert "kind" in result
        assert "id" in result
        assert "title" in result
        assert "snippet" in result
        assert "ts" in result


class TestLoadSources:
    """Test the source loading functions."""

    def test_load_sessions_handles_missing_file(self):
        """_load_sessions handles missing sessions.json gracefully."""
        with mock.patch("backend.sessions_store.list_sessions", side_effect=Exception("File not found")):
            result = palette._load_sessions()
            assert result == []

    def test_load_notes_handles_missing_dir(self):
        """_load_notes handles missing Notes directory gracefully."""
        with mock.patch("backend.notes._load_all", side_effect=Exception("Dir not found")):
            result = palette._load_notes()
            assert result == []

    def test_load_docs_handles_missing_dir(self):
        """_load_docs handles missing Documents directory gracefully."""
        with mock.patch("backend.documents.DOCS_DIR") as mock_dir:
            mock_dir.exists.return_value = False
            result = palette._load_docs()
            assert result == []


def test_search_iso_string_timestamps_do_not_crash(monkeypatch):
    """Live stores mix int epochs and ISO-8601 strings; the deploy smoke
    caught a string `updated` crashing the unary-minus recency sort. Ranking
    must coerce, and the output ts must be an int per the contract."""
    from backend import palette

    monkeypatch.setattr(palette, "_load_sessions", lambda: [
        {"id": "s1", "name": "alpha report", "created": "2026-07-20T10:00:00Z"},
        {"id": "s2", "name": "alpha notes", "created": 1752900000},
    ])
    monkeypatch.setattr(palette, "_load_notes", lambda: [
        {"id": "n1", "title": "alpha plan", "content": "x", "updated": "not-a-date"},
    ])
    monkeypatch.setattr(palette, "_load_docs", lambda: [])

    async def _no_email():
        return []
    monkeypatch.setattr(palette, "_load_email_async", _no_email)

    import asyncio
    results = asyncio.run(palette.search("alpha"))
    assert len(results) == 3
    assert all(isinstance(r["ts"], int) for r in results)
    # not-a-date coerces to 0 → ranks last among equal-rank items
    recents = asyncio.run(palette.search(""))
    assert all(isinstance(r["ts"], int) for r in recents)
