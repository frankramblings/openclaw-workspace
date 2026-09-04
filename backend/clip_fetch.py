"""Safe HTTP fetch for URL clip (backend/clip.py): a manual redirect loop
(each hop re-validated through clip_guard, not just the first URL), a
streamed body read with the size cap enforced mid-stream (a server can lie
about or omit Content-Length), and a content-type allowlist.

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


class FetchFailed(Exception):
    """The request itself failed: connection error, non-2xx status, a
    redirect with no Location header, too many redirect hops, or the total
    time budget was exhausted."""


class TooLarge(Exception):
    """The response body exceeded max_bytes, checked mid-stream (not only
    via a possibly-absent or lying Content-Length header)."""


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
                             headers={"User-Agent": _UA})


async def fetch(url: str, *, max_bytes: int, timeout_s: float, resolver=None) -> Fetched:
    """Fetch `url` under the clip safety policy. `timeout_s` is a TOTAL
    budget shared across every redirect hop, not a per-request timeout: a
    chain of slow hops must not be able to take up to
    (MAX_REDIRECTS + 1) * timeout_s by each getting its own full budget --
    the deadline below is computed once and the REMAINING time is what
    each hop's request actually gets (both as the explicit preemptive
    check before the request, and as that request's own httpx timeout
    override). Raises clip_guard.BlockedUrl (bad_url/blocked_host/
    dns_failed) if the URL or any redirect target fails the guard,
    FetchFailed for a connection error/non-2xx/redirect loop/exhausted
    time budget, TooLarge past max_bytes, or UnsupportedType for a
    content-type off the allowlist. `resolver` is forwarded to
    clip_guard.resolve_and_check on every hop (tests inject a fake DNS so
    no real lookup happens)."""
    current = clip_guard.check_url(url)
    redirects: list[str] = []
    deadline = time.monotonic() + timeout_s
    async with _make_client(timeout_s) as client:
        for hop in range(MAX_REDIRECTS + 1):
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise FetchFailed(f"timed out after {timeout_s}s (total budget across redirects)")
            host = httpx.URL(current).host
            clip_guard.resolve_and_check(host, resolver=resolver)
            try:
                async with client.stream("GET", current, timeout=remaining) as res:
                    if res.status_code in (301, 302, 303, 307, 308):
                        location = res.headers.get("location")
                        if not location:
                            raise FetchFailed(f"redirect ({res.status_code}) with no Location header")
                        if hop >= MAX_REDIRECTS:
                            raise FetchFailed(f"too many redirects (> {MAX_REDIRECTS})")
                        nxt = clip_guard.check_url(str(httpx.URL(current).join(location)))
                        redirects.append(nxt)
                        current = nxt
                        continue
                    if res.status_code >= 400:
                        raise FetchFailed(f"HTTP {res.status_code} fetching {current}")
                    content_type = _content_type_ok(res.headers.get("content-type", ""))
                    if content_type is None:
                        raise UnsupportedType(res.headers.get("content-type", "") or "(none)")
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in res.aiter_bytes():
                        total += len(chunk)
                        if total > max_bytes:
                            raise TooLarge(f"body exceeded {max_bytes} bytes")
                        chunks.append(chunk)
                    return Fetched(final_url=current, content_type=content_type,
                                   body=b"".join(chunks), redirects=redirects)
            except httpx.HTTPError as exc:
                raise FetchFailed(f"request to {current} failed: {exc}") from exc
    # Defensive only: every loop iteration above either returns or raises,
    # so this line is unreachable in practice.
    raise FetchFailed(f"too many redirects (> {MAX_REDIRECTS})")
