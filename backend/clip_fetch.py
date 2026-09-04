"""Safe HTTP fetch for URL clip (backend/clip.py): a manual redirect loop
(each hop re-validated through clip_guard, not just the first URL), a
streamed body read with the size cap AND the total time budget enforced
mid-stream (a server can lie about or omit Content-Length, and can trickle
chunks to outlast a per-request timeout), and a content-type allowlist.

httpx.AsyncClient(follow_redirects=False) is deliberate: httpx's own
redirect-follow re-validates nothing SSRF-relevant between hops, so the
redirect loop is rebuilt by hand here specifically so every hop goes back
through clip_guard.check_url + resolve_and_check before it is fetched.

Honest limitation carried over from clip_guard (documented there, not
closed here): resolve_and_check validates the resolved addresses and then
httpx resolves the SAME hostname again when it actually connects, so a
DNS-rebinding window remains between those two resolutions. Accepted for
v1 per Frank's spec decision."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import httpx

from . import clip_guard

ACCEPTED_CONTENT_TYPES = (
    "text/html", "application/xhtml+xml", "text/plain", "text/markdown",
    "application/pdf",
)
MAX_REDIRECTS = 3
_UA = "Mozilla/5.0 (compatible; GaryClip/1.0; +https://github.com/openclaw)"
_ACCEPT = "text/html, application/xhtml+xml, text/plain, text/markdown, application/pdf"
_REDIRECT_STATUS_CODES = (301, 302, 303, 307, 308)
# Decompression bomb defense (final review, Critical 1). httpx's
# res.aiter_bytes() decodes Content-Encoding (gzip/deflate/br) one socket
# read at a time, BEFORE any size check this module can make, so a 172-byte
# brotli body declaring 200 MiB of zeros allocated 175 MiB here before the
# 5 MB cap ever fired. Two halves to the fix, both required: ask for an
# identity (unencoded) body, and refuse outright any response that comes
# back encoded anyway, before a single byte is handed to a decoder. With
# every encoded response refused, the body loop's aiter_bytes() has nothing
# left to decode, so the cap counts WIRE bytes and the worst case is
# exactly max_bytes in memory.
_ACCEPT_ENCODING = "identity"
_IDENTITY_ENCODINGS = ("", "identity")

log = logging.getLogger(__name__)


class FetchFailed(Exception):
    """The request itself failed: connection error, non-2xx/non-200 status,
    a redirect with no Location header, too many redirect hops, or the
    total time budget was exhausted (during connect or mid-body-read).

    `reason` is a short machine-stable string (too_many_redirects,
    redirect_without_location, timeout, http_status, transport,
    unsupported_encoding) that
    backend/clip.py (Task 4) can map onto an HTTP error code without
    parsing prose. `message` (what str(exc) returns) is always short and
    safe to surface. `detail` is additional diagnostic text for logging;
    for a transport failure it MAY contain a raw exception message (a TLS
    error, an internal IP, a source path) and so is never folded into
    `message` -- see the httpx.HTTPError handler in fetch()."""

    def __init__(self, reason: str, message: str = "", *, detail: str = ""):
        super().__init__(message or reason)
        self.reason = reason
        self.detail = detail or message or reason


class TooLarge(Exception):
    """The response body exceeded max_bytes, checked mid-stream (not only
    via a possibly-absent or lying Content-Length header). reason is
    always "too_large" so callers don't need to string-match."""

    def __init__(self, detail: str = ""):
        message = detail or "response body exceeded the configured size cap"
        super().__init__(message)
        self.reason = "too_large"
        self.detail = message


class UnsupportedType(Exception):
    """The response's Content-Type is not in ACCEPTED_CONTENT_TYPES."""

    def __init__(self, content_type: str):
        super().__init__(f"unsupported content-type: {content_type}")
        self.content_type = content_type


@dataclass
class Fetched:
    final_url: str
    content_type: str
    body: bytes
    redirects: list[str] = field(default_factory=list)


def _content_type_ok(header: str) -> str | None:
    """The bare media type (no ;charset=...) if it is on the allowlist,
    else None."""
    media = (header or "").split(";", 1)[0].strip().lower()
    return media if media in ACCEPTED_CONTENT_TYPES else None


def _make_client(timeout_s: float) -> httpx.AsyncClient:
    """Factory so tests can inject an httpx.MockTransport instead of
    hitting the network: same "kept as a function so tests can monkeypatch
    cleanly" reasoning as documents._find_pandoc (backend/documents.py:140-147)."""
    return httpx.AsyncClient(follow_redirects=False, timeout=timeout_s,
                             headers={"User-Agent": _UA, "Accept": _ACCEPT,
                                      "Accept-Encoding": _ACCEPT_ENCODING})


def _join_location(current: str, location: str) -> str:
    """Absolutize a redirect's Location against the URL it came from. Its
    own function (rather than inline in fetch) so a test can make the join
    itself fail: httpx rejects the crudest malformed Location values in its
    own header parsing, before fetch() ever sees them, but httpx.URL.join
    can still raise httpx.InvalidURL, which is NOT an httpx.HTTPError and
    so is not covered by fetch's transport handler."""
    return str(httpx.URL(current).join(location))


async def fetch(url: str, *, max_bytes: int, timeout_s: float, resolver=None) -> Fetched:
    """Fetch `url` under the clip safety policy. `timeout_s` is a TOTAL
    budget shared across every redirect hop AND the body read of the final
    hop, not a per-request timeout: a chain of slow hops (or a single hop
    that trickles its body) must not be able to run past timeout_s just
    because each individual read stays under httpx's own per-operation
    read timeout. `deadline` is computed once, up front, and is checked
    both preemptively before each hop's request and again on every chunk
    of the body read (see the aiter_bytes loop below) -- that second check
    is the one that actually bounds total wall-clock time, since a scalar/
    per-phase httpx timeout only bounds a SINGLE read operation, not the
    sum of many small ones. Raises clip_guard.BlockedUrl (bad_url/
    blocked_host/dns_failed) if the URL or any redirect target fails the
    guard, FetchFailed for a connection error/non-200 status/redirect
    loop/exhausted time budget, TooLarge past max_bytes, or UnsupportedType
    for a content-type off the allowlist.

    Known slack in the budget (final review, Minor 1): the deadline is
    checked before each hop and after each body chunk arrives, but the
    per-hop httpx read timeout is `remaining` computed at hop start. A
    server that delivers one chunk just inside the deadline and then
    stalls forever is cut off by that read timeout rather than by the
    deadline, so the true worst case is about 2x timeout_s (30 s at the
    default). Accepted: it is bounded, and it takes a deliberately
    adversarial server to reach it.

    `resolver` is forwarded to
    clip_guard.resolve_and_check on every hop (tests inject a fake DNS so
    no real lookup happens)."""
    current = clip_guard.check_url(url)
    redirects: list[str] = []
    deadline = time.monotonic() + timeout_s
    async with _make_client(timeout_s) as client:
        for hop in range(MAX_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FetchFailed("timeout", f"timed out after {timeout_s}s (total budget across redirects)")
            host = httpx.URL(current).host
            clip_guard.resolve_and_check(host, resolver=resolver)
            # Minor 8: clear any cookies the previous hop's response set
            # before issuing the next hop's request -- a clip fetch must
            # not replay a Set-Cookie from one host onto a later hop.
            client.cookies.clear()
            # Explicit per-phase timeout (rather than relying on the
            # scalar shorthand) so it's clear connect/read/write/pool each
            # get the SAME remaining-budget ceiling. This alone is NOT
            # sufficient to bound the total body-read time: httpx's read
            # timeout applies per operation/chunk, not cumulatively across
            # the whole stream, so a server trickling small chunks just
            # inside each read timeout would otherwise run far past
            # timeout_s. The deadline check inside the aiter_bytes loop
            # below is what actually enforces the total budget during a
            # body read.
            per_hop_timeout = httpx.Timeout(remaining, connect=remaining, read=remaining,
                                             write=remaining, pool=remaining)
            try:
                async with client.stream("GET", current, timeout=per_hop_timeout) as res:
                    if res.status_code in _REDIRECT_STATUS_CODES:
                        location = res.headers.get("location")
                        if not location:
                            raise FetchFailed("redirect_without_location",
                                               f"redirect ({res.status_code}) with no Location header")
                        if hop >= MAX_REDIRECTS:
                            raise FetchFailed("too_many_redirects",
                                               f"too many redirects (> {MAX_REDIRECTS})")
                        try:
                            target = _join_location(current, location)
                        except (httpx.InvalidURL, ValueError) as exc:
                            # Final review, Minor 2: httpx.InvalidURL is NOT an
                            # httpx.HTTPError, so a hostile Location used to
                            # escape fetch() entirely and land in the route's
                            # catch-all as a misleading "fetch failed".
                            raise clip_guard.BlockedUrl(
                                "bad_url", "unparseable redirect target") from exc
                        nxt = clip_guard.check_url(target)
                        # Minor 6 (Frank's ruling): an https -> http
                        # downgrade on redirect is allowed here -- a clip
                        # fetch carries no credentials and cookies are
                        # cleared per hop above, so refusing the downgrade
                        # would only break sites that redirect to a plain-
                        # http mirror/CDN, for no corresponding safety gain.
                        redirects.append(nxt)
                        current = nxt
                        continue
                    if res.status_code != 200:
                        # Minor 7: only a plain 200 proceeds to the body.
                        # 204/206/300/304 and anything else (not just >=400)
                        # is refused rather than silently mishandled.
                        raise FetchFailed("http_status", f"HTTP {res.status_code} fetching {current}")
                    content_type = _content_type_ok(res.headers.get("content-type", ""))
                    if content_type is None:
                        raise UnsupportedType(res.headers.get("content-type", "") or "(none)")
                    encoding = (res.headers.get("content-encoding") or "").strip().lower()
                    if encoding not in _IDENTITY_ENCODINGS:
                        # Refused BEFORE the body loop, so no compressed byte
                        # ever reaches a decoder (see _ACCEPT_ENCODING above).
                        raise FetchFailed("unsupported_encoding",
                                           f"response used content-encoding {encoding!r}, "
                                           "only an identity (unencoded) body is accepted")
                    chunks: list[bytes] = []
                    total = 0
                    # aiter_bytes only ever DECODES a declared
                    # content-encoding, and the check just above has already
                    # refused every response that declares one, so these are
                    # raw wire bytes: `total` is a true bound on how much
                    # memory this response can cost.
                    async for chunk in res.aiter_bytes():
                        if time.monotonic() > deadline:
                            raise FetchFailed(
                                "timeout",
                                f"timed out after {timeout_s}s reading the response "
                                "body (total budget across redirects)",
                            )
                        total += len(chunk)
                        if total > max_bytes:
                            raise TooLarge(f"body exceeded {max_bytes} bytes")
                        chunks.append(chunk)
                    return Fetched(final_url=current, content_type=content_type,
                                   body=b"".join(chunks), redirects=redirects)
            except httpx.HTTPError as exc:
                reason = "timeout" if isinstance(exc, httpx.TimeoutException) else "transport"
                # The raw exception text (exc) can contain internal detail
                # (a TLS error, an internal IP, a CPython source path) that
                # must never reach a user-facing error message -- it is
                # logged here and kept on FetchFailed.detail for
                # diagnostics, but FetchFailed's short `message` (what
                # str(exc) returns) only ever names the exception class.
                log.warning("clip_fetch: request to %s failed (%s): %s", current, type(exc).__name__, exc)
                raise FetchFailed(reason, f"request failed ({type(exc).__name__})",
                                   detail=f"{type(exc).__name__}: {exc}") from exc
    # Defensive only: every loop iteration above either returns or raises,
    # so this line is unreachable in practice.
    raise FetchFailed("too_many_redirects", f"too many redirects (> {MAX_REDIRECTS})")
