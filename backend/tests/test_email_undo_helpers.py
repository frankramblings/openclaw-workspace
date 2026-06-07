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
    async def fake_run_raw(args, **kw):
        # -o json must come BEFORE the query positional: himalaya's variadic
        # query parser swallows trailing options (verified live, v1.2.0).
        assert args[:4] == ["envelope", "list", "-f", "[Gmail]/Trash"]
        oi, qi = args.index("-o"), args.index('subject "Weekly digest"')
        assert oi < qi and args[oi + 1] == "json"
        return b'[{"id": "777", "subject": "Weekly digest"}]'
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_raw", fake_run_raw)
    uid = await email_himalaya.find_uid("[Gmail]/Trash", "Weekly digest", "")
    assert uid == "777"


@pytest.mark.anyio
async def test_find_uid_none_when_no_match(monkeypatch):
    async def fake_run_raw(args, **kw):
        return b""   # himalaya emits empty stdout for some no-result paths
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_raw", fake_run_raw)
    assert await email_himalaya.find_uid("[Gmail]/Trash", "X y z", "") is None


@pytest.mark.anyio
async def test_find_uid_refuses_empty_subject(monkeypatch):
    async def explode(args, **kw):
        raise AssertionError("must not query IMAP with a match-all subject")
    monkeypatch.setattr(email_himalaya.himalaya_cli, "run_raw", explode)
    assert await email_himalaya.find_uid("[Gmail]/Trash", '""…', "a@b.c") is None
    assert await email_himalaya.find_uid("[Gmail]/Trash", "   ", "") is None


@pytest.fixture
def anyio_backend():
    return "asyncio"
