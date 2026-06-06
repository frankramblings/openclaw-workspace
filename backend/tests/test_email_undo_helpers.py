"""Unit tests for the undo helpers: search-query building + uid resolution."""
import pytest

from backend import email_himalaya


def test_search_query_sanitizes_subject():
    # himalaya list-output subjects may be pre-truncated with a literal …;
    # quotes break the query grammar. Both must be stripped; prefix-substring
    # match is what IMAP SEARCH does anyway.
    q = email_himalaya.search_query('💬 New "comment" on: [SOCIAL] Mochi R…',
                                    "no-reply@asana.com")
    assert q == ('subject "💬 New comment on: [SOCIAL] Mochi R" '
                 'and from "no-reply@asana.com"')


def test_search_query_without_from():
    assert email_himalaya.search_query("Hello world", "") == 'subject "Hello world"'


@pytest.mark.anyio
async def test_find_uid_returns_first_match(monkeypatch):
    async def fake_run_json(args):
        assert args[:4] == ["envelope", "list", "-f", "[Gmail]/Trash"]
        assert args[-1] == 'subject "Weekly digest"'
        return [{"id": "777", "subject": "Weekly digest"}]
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_json", fake_run_json)
    uid = await email_himalaya.find_uid("[Gmail]/Trash", "Weekly digest", "")
    assert uid == "777"


@pytest.mark.anyio
async def test_find_uid_none_when_no_match(monkeypatch):
    async def fake_run_json(args):
        return []
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_json", fake_run_json)
    assert await email_himalaya.find_uid("[Gmail]/Trash", "X y z", "") is None


@pytest.fixture
def anyio_backend():
    return "asyncio"
