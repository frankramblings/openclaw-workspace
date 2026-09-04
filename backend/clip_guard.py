"""URL clip safety: SSRF guard for the URL-clip feature (backend/clip.py).

No fetch happens here. check_url is a pure, fast pre-flight gate on the
literal URL text (scheme, userinfo, static host-name denylist, IP-literal
host, numeric-IP-lookalike hostnames); resolve_and_check is the DNS-time
gate that must run again on every redirect hop (backend/clip_fetch.py)
since a hostname that looks safe can still resolve to a private address
(DNS rebinding).

Honest limitation, not fully closed by this guard: this is a
check-then-connect design (resolve_and_check validates the resolved
addresses, then httpx resolves the SAME hostname again when it actually
connects), so a rebinding window remains between those two resolutions.
v1's mitigation is the per-hop re-check (backend/clip_fetch.py) plus the
private-range deny list, which closes the practical case (a redirect or a
plain lookup landing on a static internal host); it does not close a
live, precisely-timed DNS-rebinding attack (an attacker-controlled answer
with TTL 0 flipping between the two resolutions). Closing that fully
needs connecting directly to the already-checked IP with the original
Host header preserved (an httpx transport-level change), which is not
built in this plan and is flagged in Task 7's spec fold-back as a new
open decision for Frank.

No allowlist/SSRF guard existed anywhere in this codebase before this
module (backend/websearch.py only ever calls SerpAPI's own JSON API, never
an arbitrary user URL): everything here is new policy, not a reuse of an
existing pattern."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit

_BLOCKED_SUFFIXES = (".local", ".internal", ".lan")
_BLOCKED_HOSTNAMES = {"localhost"}
# A hostname made only of digits and dots (any label count, including a
# leading-zero label like "0177") or starting with "0x". ipaddress.ip_address
# is strict (exactly four decimal octets, no leading zeros) so it does NOT
# parse a bare 32-bit decimal (2130706433 == 127.0.0.1), a short dotted form
# (127.1 == 127.0.0.1), a hex form (0x7f000001), or an octal-looking dotted
# form (0177.0.0.1) -- those fall through _literal_ip as "not a literal" and
# would otherwise reach resolve_and_check/DNS, where some platform resolvers
# (libc inet_aton-family numeric-address fallbacks) still accept them as
# real IPv4 addresses. A real DNS hostname is never purely digits and dots
# together with no letters anywhere, so rejecting this shape outright is safe.
_NUMERIC_HOST_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")
# The character set a real hostname/dotted-IPv4 (letters, digits, hyphen,
# dot) or an IPv6 literal (hex digits, colon, dot for the IPv4-mapped
# form) can legally contain. Anything else -- a NUL byte, an embedded
# space, control characters -- is rejected up front as bad_url instead of
# being handed to a DNS resolver or a socket call downstream.
_HOSTNAME_CHARS_RE = re.compile(r"^[a-z0-9.\-]+$")
_IPV6_LITERAL_CHARS_RE = re.compile(r"^[0-9a-f:.]+$")
# RFC 6598 shared address space (carrier-grade NAT). ipaddress reports this
# range as neither private nor reserved, so it needs its own membership
# check rather than falling out of the is_private/is_reserved properties
# _is_blocked_ip otherwise relies on.
_SHARED_ADDRESS_SPACE = ipaddress.ip_network("100.64.0.0/10")


def _looks_like_numeric_ip_obfuscation(host: str) -> bool:
    return host.startswith("0x") or bool(_NUMERIC_HOST_RE.match(host))


def _host_has_valid_charset(host: str) -> bool:
    """True if `host` (already lowercased) is built only from characters a
    real hostname or IP literal can contain. A colon only ever appears in
    an IPv6 literal (urlsplit already rejects a syntactically-broken
    bracket form before this runs, so a colon here means the bracket
    contents were at least well-formed IPv6 syntax); anything else must be
    a DNS name or dotted IPv4, which never contains a colon."""
    if ":" in host:
        return bool(_IPV6_LITERAL_CHARS_RE.match(host))
    return bool(_HOSTNAME_CHARS_RE.match(host))


class BlockedUrl(Exception):
    """Raised by check_url/resolve_and_check when a URL or a resolved
    address fails the SSRF guard. `reason` is a short machine-stable string
    (bad_url, blocked_host, dns_failed) that backend/clip.py maps onto an
    HTTP error code; `detail` is the human-readable message."""

    def __init__(self, reason: str, detail: str = ""):
        super().__init__(detail or reason)
        self.reason = reason
        self.detail = detail or reason


def _literal_ip(host: str):
    """Parse `host` as an IP literal (IPv6 in [brackets] or bare). None if
    it is not a literal (i.e. it is a DNS name)."""
    h = host[1:-1] if host.startswith("[") and host.endswith("]") else host
    try:
        return ipaddress.ip_address(h)
    except ValueError:
        return None


def _is_blocked_ip(ip) -> bool:
    """True for loopback/RFC1918/link-local/multicast/reserved/unspecified,
    RFC 6598 shared (CGNAT) address space, their IPv6 equivalents, and an
    IPv4-mapped IPv6 address whose embedded IPv4 is any of the above
    (::ffff:127.0.0.1 must not slip past the guard just because the outer
    address is technically IPv6)."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv4Address) and ip in _SHARED_ADDRESS_SPACE:
        return True
    return bool(
        ip.is_loopback or ip.is_private or ip.is_link_local
        or ip.is_multicast or ip.is_reserved or ip.is_unspecified
        or getattr(ip, "is_site_local", False)  # deprecated IPv6 fec0::/10, IPv4Address has no such attr
    )


def check_url(url: str) -> str:
    """Validate `url`'s scheme, credentials, and hostname shape; return it
    normalized (scheme + host lowercased, a trailing root-label dot
    stripped, default port stripped, empty path becomes "/", fragment
    dropped: fragments never reach the server and a stable normalized form
    is what backend/clip.py keys re-clip matching on). Raises BlockedUrl(
    reason='bad_url') for a non-http(s) scheme, embedded credentials, an
    unparseable/hostless URL, or a host containing a character outside the
    hostname alphabet; BlockedUrl(reason='blocked_host') for localhost, a
    `.local`/`.internal`/`.lan` suffix, or an IP-literal host in a blocked
    range. The root-label dot ("example.com." is the same host as
    "example.com") is stripped before every one of those checks runs, not
    just before the range check, since it defeats an exact-match hostname
    comparison ("localhost." != "localhost") just as easily as it defeats
    the numeric-obfuscation and IP-literal checks."""
    if not isinstance(url, str) or not url.strip():
        raise BlockedUrl("bad_url", "empty URL")
    raw = url.strip()
    try:
        parts = urlsplit(raw)
    except ValueError as exc:
        raise BlockedUrl("bad_url", f"unparseable URL: {exc}") from exc
    scheme = parts.scheme.lower()
    if scheme not in ("http", "https"):
        raise BlockedUrl("bad_url", f"scheme must be http or https, got {parts.scheme!r}")
    if parts.username or parts.password:
        raise BlockedUrl("bad_url", "credentials in the URL are not allowed")
    host = parts.hostname
    if not host:
        raise BlockedUrl("bad_url", "URL has no host")
    host = host.lower()
    if host.endswith("."):
        host = host[:-1]
    if not host:
        raise BlockedUrl("bad_url", "URL has no host")
    if not _host_has_valid_charset(host):
        raise BlockedUrl("bad_url", f"host {host!r} contains characters outside the hostname alphabet")
    if host in _BLOCKED_HOSTNAMES or host.endswith(_BLOCKED_SUFFIXES):
        raise BlockedUrl("blocked_host", f"{host} is not a fetchable host")
    literal = _literal_ip(host)
    if literal is not None:
        if _is_blocked_ip(literal):
            raise BlockedUrl("blocked_host", f"{host} resolves to a blocked address range")
    elif _looks_like_numeric_ip_obfuscation(host):
        # Not parseable by ipaddress (see _NUMERIC_HOST_RE's comment above)
        # but still numeric-shaped: reject before it ever reaches DNS.
        raise BlockedUrl("bad_url", f"{host} looks like a numeric IP address in disguise, not a real hostname")
    netloc = f"[{host}]" if literal is not None and literal.version == 6 else host
    if parts.port is not None:
        default_port = 80 if scheme == "http" else 443
        if parts.port != default_port:
            netloc += f":{parts.port}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def resolve_and_check(host: str, *, resolver=None) -> list[str]:
    """Resolve `host` (an IP-literal host skips DNS entirely) and require
    EVERY returned address to pass the same range check check_url applies
    to a literal-IP host. This is the anti-DNS-rebinding gate: a hostname
    can pass check_url's static text check and still resolve to 127.0.0.1
    by the time the request actually fires. `resolver` defaults to
    socket.getaddrinfo(host, None); tests inject a fake with signature
    resolver(host, port) -> list of getaddrinfo-shaped tuples, so no real
    DNS lookup happens under test. Raises BlockedUrl(reason='blocked_host')
    if any address is blocked, or (reason='dns_failed') if resolution
    itself raises -- any Exception, not just the OSError a real
    socket.getaddrinfo raises, since an injected/custom resolver can fail
    in other ways and this must fail closed regardless."""
    getaddrinfo = resolver or socket.getaddrinfo
    literal = _literal_ip(host)
    if literal is not None:
        return [str(literal)]
    try:
        infos = getaddrinfo(host, None)
    except Exception as exc:
        raise BlockedUrl("dns_failed", f"could not resolve {host}: {exc}") from exc
    addrs = sorted({info[4][0] for info in infos})
    if not addrs:
        raise BlockedUrl("dns_failed", f"{host} resolved to no addresses")
    for addr in addrs:
        ip = _literal_ip(addr)
        if ip is None or _is_blocked_ip(ip):
            raise BlockedUrl("blocked_host", f"{host} resolved to blocked address {addr}")
    return addrs
