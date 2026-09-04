"""backend/clip_fetch.py: the safe HTTP fetch stage. httpx.MockTransport
replaces the network via clip_fetch._make_client (the injection seam,
mirroring documents._find_pandoc's "kept as a function so tests can
monkeypatch cleanly" pattern). A resolver stub replaces real DNS so these
tests never touch the network even for hostname resolution."""
import asyncio

import httpx
import pytest

from backend import clip_fetch as cf
from backend import clip_guard as cg


def _resolver(*_a, **_kw):
    return [(2, 1, 6, "", ("93.184.216.34", 0))]


def _client_with(handler, monkeypatch):
    def make_client(timeout_s):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler),
                                 follow_redirects=False, timeout=timeout_s)
    monkeypatch.setattr(cf, "_make_client", make_client)


@pytest.mark.asyncio
async def test_fetch_returns_body_and_content_type(monkeypatch):
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html; charset=utf-8"},
                              content=b"<html><body>hi</body></html>")
    _client_with(handler, monkeypatch)
    out = await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert out.final_url == "https://example.com/a"
    assert out.content_type == "text/html"
    assert out.body == b"<html><body>hi</body></html>"
    assert out.redirects == []


@pytest.mark.asyncio
async def test_fetch_follows_redirects_up_to_the_cap(monkeypatch):
    hops = {"n": 0}
    def handler(request):
        hops["n"] += 1
        if hops["n"] <= 3:
            return httpx.Response(302, headers={"location": f"https://example.com/hop{hops['n']}"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"done")
    _client_with(handler, monkeypatch)
    out = await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert out.body == b"done"
    assert out.redirects == ["https://example.com/hop1", "https://example.com/hop2", "https://example.com/hop3"]
    assert hops["n"] == 4


@pytest.mark.asyncio
async def test_fetch_enforces_a_total_time_budget_across_redirect_hops(monkeypatch):
    # The 15s cap (backend/clip.py's default) is a TOTAL budget across every
    # hop, not a per-hop timeout -- a per-hop timeout would let a chain of
    # slow redirects take up to (MAX_REDIRECTS + 1) * timeout_s. Prove it by
    # burning the ENTIRE (small) budget on hop 1's real wall-clock delay and
    # asserting hop 2 is never even attempted, because fetch()'s own deadline
    # check (not httpx's per-request timeout, which a MockTransport handler
    # can simply ignore by sleeping) is what has to catch this.
    hops = {"n": 0}
    async def handler(request):
        hops["n"] += 1
        if hops["n"] == 1:
            await asyncio.sleep(0.15)
            return httpx.Response(302, headers={"location": "https://example.com/hop2"})
        raise AssertionError("must not reach hop 2: the total budget was already spent on hop 1")
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed, match="timed out"):
        await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=0.05, resolver=_resolver)
    assert hops["n"] == 1


@pytest.mark.asyncio
async def test_fetch_too_many_redirects_fails(monkeypatch):
    def handler(request):
        return httpx.Response(302, headers={"location": "https://example.com/next"})
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed, match="too many redirects"):
        await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=5, resolver=_resolver)


@pytest.mark.asyncio
async def test_fetch_redirect_to_blocked_host_is_rejected_before_following(monkeypatch):
    def handler(request):
        if str(request.url) == "https://example.com/start":
            return httpx.Response(302, headers={"location": "http://127.0.0.1/admin"})
        raise AssertionError("must not fetch the redirect target")
    _client_with(handler, monkeypatch)
    with pytest.raises(cg.BlockedUrl):
        await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=5, resolver=_resolver)


@pytest.mark.asyncio
async def test_fetch_rejects_unsupported_content_type(monkeypatch):
    def handler(request):
        return httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNG")
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.UnsupportedType) as ei:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert ei.value.content_type == "image/png"


@pytest.mark.asyncio
async def test_fetch_enforces_size_cap_mid_stream(monkeypatch):
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"x" * 5000)
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.TooLarge):
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)


@pytest.mark.asyncio
async def test_fetch_maps_http_error_status_to_fetch_failed(monkeypatch):
    def handler(request):
        return httpx.Response(404)
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed, match="404"):
        await cf.fetch("https://example.com/missing", max_bytes=1000, timeout_s=5, resolver=_resolver)


@pytest.mark.asyncio
async def test_fetch_maps_connection_error_to_fetch_failed(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused", request=request)
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed, match="refused"):
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)


@pytest.mark.asyncio
async def test_fetch_rejects_the_initial_url_before_any_request(monkeypatch):
    calls = []
    def handler(request):
        calls.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"x")
    _client_with(handler, monkeypatch)
    with pytest.raises(cg.BlockedUrl):
        await cf.fetch("http://localhost/admin", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert calls == []
