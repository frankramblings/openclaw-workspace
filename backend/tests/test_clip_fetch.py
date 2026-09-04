"""backend/clip_fetch.py: the safe HTTP fetch stage. httpx.MockTransport
replaces the network via clip_fetch._make_client (the injection seam,
mirroring documents._find_pandoc's "kept as a function so tests can
monkeypatch cleanly" pattern). A resolver stub replaces real DNS so these
tests never touch the network even for hostname resolution."""
import asyncio
import time

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


class _SlowBody(httpx.AsyncByteStream):
    """An async byte stream that yields each chunk only after a real
    asyncio.sleep -- proves fetch()'s total-budget check has to be its own
    wall-clock deadline check inside the read loop, not just a timeout=
    passed to httpx, since a MockTransport handler bypasses httpx's own
    per-operation timeout machinery entirely."""

    def __init__(self, chunks, delay):
        self._chunks = chunks
        self._delay = delay

    async def __aiter__(self):
        for chunk in self._chunks:
            await asyncio.sleep(self._delay)
            yield chunk

    async def aclose(self):
        pass


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
    with pytest.raises(cf.FetchFailed) as ei:
        await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=0.05, resolver=_resolver)
    assert ei.value.reason == "timeout"
    assert hops["n"] == 1


@pytest.mark.asyncio
async def test_fetch_enforces_total_budget_during_a_slow_body_stream(monkeypatch):
    # Critical fix-round-1 finding: a server trickling small chunks, each
    # comfortably inside a single read's own timeout, must not be able to
    # outlast the TOTAL budget just because no individual read ever trips
    # httpx's per-operation read timeout. fetch()'s own deadline check
    # inside the aiter_bytes loop -- not the timeout= passed to httpx -- is
    # what has to catch this.
    async def handler(request):
        return httpx.Response(200, headers={"content-type": "text/plain"},
                              stream=_SlowBody([b"x" * 10] * 30, 0.03))
    _client_with(handler, monkeypatch)
    start = time.monotonic()
    with pytest.raises(cf.FetchFailed) as ei:
        await cf.fetch("https://example.com/a", max_bytes=10_000, timeout_s=0.2, resolver=_resolver)
    elapsed = time.monotonic() - start
    assert ei.value.reason == "timeout"
    assert elapsed < 0.4  # well under 2x the 0.2s budget


@pytest.mark.asyncio
async def test_fetch_too_many_redirects_fails(monkeypatch):
    def handler(request):
        return httpx.Response(302, headers={"location": "https://example.com/next"})
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed) as ei:
        await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert ei.value.reason == "too_many_redirects"


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
    with pytest.raises(cf.TooLarge) as ei:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert ei.value.reason == "too_large"


@pytest.mark.asyncio
async def test_fetch_maps_http_error_status_to_fetch_failed(monkeypatch):
    def handler(request):
        return httpx.Response(404)
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed) as ei:
        await cf.fetch("https://example.com/missing", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert ei.value.reason == "http_status"
    assert "404" in str(ei.value)


@pytest.mark.asyncio
async def test_fetch_rejects_non_200_status_even_when_not_an_error_code(monkeypatch):
    # Minor fix-round-1 item: only a plain 200 proceeds to the body path.
    # 206 (partial content) is a real, "successful" status a misconfigured
    # or Range-aware origin could return, but clip_fetch has no partial-
    # content handling, so it must be refused rather than silently treated
    # like a full 200 body.
    def handler(request):
        return httpx.Response(206, headers={"content-type": "text/plain"}, content=b"partial")
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed) as ei:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert ei.value.reason == "http_status"


@pytest.mark.asyncio
async def test_fetch_maps_connection_error_to_fetch_failed(monkeypatch):
    def handler(request):
        raise httpx.ConnectError("refused", request=request)
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed) as ei:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert ei.value.reason == "transport"
    # Important fix-round-1 finding: the raw exception text (which can
    # contain TLS internals, internal IPs, a source path) must never land
    # in the short exception message -- only in the .detail attribute and
    # the logging.warning call inside fetch().
    assert "refused" not in str(ei.value)
    assert "refused" in ei.value.detail


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


@pytest.mark.asyncio
async def test_fetch_does_not_replay_cookies_across_hops(monkeypatch):
    seen_cookie_headers = []
    def handler(request):
        seen_cookie_headers.append(request.headers.get("cookie"))
        if str(request.url) == "https://example.com/start":
            return httpx.Response(302, headers={
                "location": "https://example.com/next",
                "set-cookie": "session=abc123; Path=/",
            })
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"ok")
    _client_with(handler, monkeypatch)
    out = await cf.fetch("https://example.com/start", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert out.body == b"ok"
    # Neither request carried a Cookie header: the first hop had none to
    # send, and the second hop must not replay the first hop's Set-Cookie.
    assert seen_cookie_headers == [None, None]


@pytest.mark.asyncio
async def test_make_client_uses_safe_defaults():
    # Unlike the other tests, this exercises the REAL _make_client (not the
    # MockTransport-injected replacement, which the brief's _client_with
    # helper builds without any headers) so its own configuration -- not
    # just fetch()'s use of it -- is under test.
    async with cf._make_client(5) as client:
        assert client.follow_redirects is False
        assert client.headers.get("user-agent") == cf._UA
        assert client.headers.get("accept") == cf._ACCEPT
        assert client.headers.get("accept-encoding") == "identity"
        assert client.timeout == httpx.Timeout(5)


@pytest.mark.asyncio
async def test_fetch_requests_an_identity_encoding(monkeypatch):
    """The other half of the decompression-bomb fix (final review, C1):
    ask servers not to compress in the first place, so the refusal below
    only ever fires against a server that ignored the request."""
    seen = {}

    def handler(request):
        seen["accept-encoding"] = request.headers.get("accept-encoding")
        return httpx.Response(200, headers={"content-type": "text/html"}, content=b"<p>hi</p>")

    def make_client(timeout_s):
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False,
                                 timeout=timeout_s,
                                 headers={"User-Agent": cf._UA, "Accept": cf._ACCEPT,
                                          "Accept-Encoding": cf._ACCEPT_ENCODING})
    monkeypatch.setattr(cf, "_make_client", make_client)
    await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert seen["accept-encoding"] == "identity"


@pytest.mark.asyncio
async def test_fetch_refuses_a_compressed_body_without_decoding_it(monkeypatch):
    """A 200 MiB-of-zeros brotli bomb compresses to a few hundred bytes.
    Before the fix, httpx's aiter_bytes decoded it one socket read at a
    time and the size cap only ever saw the DECODED length, so the process
    grew by about 175 MiB before too_large fired. The response is now
    refused on its content-encoding header, before a single byte reaches a
    decoder, so peak RSS barely moves."""
    import resource

    brotli = pytest.importorskip("brotli")
    bomb = brotli.compress(b"\0" * (200 * 1024 * 1024))
    assert len(bomb) < 4096
    iterated = []

    class _BombStream(httpx.AsyncByteStream):
        """A real streaming body (not a materialized `content=`, which
        MockTransport would read and decode itself before fetch() ever saw
        the response) so this test can prove the refusal happens BEFORE any
        byte is pulled through the decoder."""

        async def __aiter__(self):
            iterated.append(True)
            yield bomb

        async def aclose(self):
            pass

    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html",
                                            "content-encoding": "br"},
                              stream=_BombStream())
    _client_with(handler, monkeypatch)
    before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    with pytest.raises(cf.FetchFailed) as exc:
        await cf.fetch("https://example.com/a", max_bytes=5 * 1024 * 1024, timeout_s=5,
                       resolver=_resolver)
    after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    assert exc.value.reason == "unsupported_encoding"
    assert iterated == [], "the compressed body must never be read or decoded"
    # ru_maxrss is in KiB on Linux: the bomb would have added about 190 MiB.
    assert after - before < 50 * 1024


@pytest.mark.asyncio
async def test_fetch_accepts_an_explicit_identity_encoding(monkeypatch):
    def handler(request):
        return httpx.Response(200, headers={"content-type": "text/html",
                                            "content-encoding": "identity"},
                              content=b"<p>hi</p>")
    _client_with(handler, monkeypatch)
    out = await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert out.body == b"<p>hi</p>"


@pytest.mark.asyncio
async def test_fetch_rejects_an_unparseable_redirect_target(monkeypatch):
    """Final review, Minor 2: httpx.InvalidURL is not an httpx.HTTPError,
    so an unjoinable Location used to escape fetch() entirely and reach the
    route's catch-all as a misleading "fetch failed". httpx's own header
    parsing rejects the crudest malformed Location values before fetch()
    sees them, so the join itself is made to fail here."""
    def handler(request):
        return httpx.Response(302, headers={"location": "/next"})

    def bad_join(current, location):
        raise httpx.InvalidURL("nope")
    monkeypatch.setattr(cf, "_join_location", bad_join)
    _client_with(handler, monkeypatch)
    with pytest.raises(cg.BlockedUrl) as exc:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert exc.value.reason == "bad_url"


@pytest.mark.asyncio
async def test_fetch_redirect_to_a_dns_private_host_is_refused_before_connecting(monkeypatch):
    """Spec 3.3's second redirect case: hop 2's target is an ordinary
    hostname, and only DNS reveals that it points into a private range.
    Nothing must connect to it."""
    requested = []

    def handler(request):
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://internal.example/secret"})

    def resolver(host, port=None):
        if host == "internal.example":
            return [(2, 1, 6, "", ("10.0.0.5", 0))]
        return [(2, 1, 6, "", ("93.184.216.34", 0))]
    _client_with(handler, monkeypatch)
    with pytest.raises(cg.BlockedUrl) as exc:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=resolver)
    assert exc.value.reason == "blocked_host"
    assert requested == ["https://example.com/a"]


@pytest.mark.asyncio
async def test_fetch_maps_a_read_timeout_to_the_timeout_reason(monkeypatch):
    def handler(request):
        raise httpx.ReadTimeout("too slow", request=request)
    _client_with(handler, monkeypatch)
    with pytest.raises(cf.FetchFailed) as exc:
        await cf.fetch("https://example.com/a", max_bytes=1000, timeout_s=5, resolver=_resolver)
    assert exc.value.reason == "timeout"
