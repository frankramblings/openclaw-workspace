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
built in this plan: it is spec decision 14, which Frank decided by
accepting this residual window for v1.

No allowlist/SSRF guard existed anywhere in this codebase before this
module (backend/websearch.py only ever calls SerpAPI's own JSON API, never
an arbitrary user URL): everything here is new policy, not a reuse of an
existing pattern."""
from __future__ import annotations

import ipaddress
import re
import socket
from urllib.parse import urlsplit, urlunsplit

_BLOCKED_SUFFIXES = (".local", ".internal", ".lan", ".localhost")
_BLOCKED_HOSTNAMES = {"localhost"}
# A numeric-IP lookalike hostname: EVERY dot-separated label is either all
# decimal digits or an "0x" hex literal. ipaddress.ip_address is strict
# (exactly four decimal octets, no leading zeros) so it does NOT parse a bare
# 32-bit decimal (2130706433 == 127.0.0.1), a short dotted form
# (127.1 == 127.0.0.1), a hex form (0x7f000001), or an octal-looking dotted
# form (0177.0.0.1) -- those fall through _literal_ip as "not a literal" and
# would otherwise reach resolve_and_check/DNS, where some platform resolvers
# (libc inet_aton-family numeric-address fallbacks) still accept them as
# real IPv4 addresses. Final review, Minor 3: the per-label rule also covers
# the MIXED forms a digits-only pattern missed ("127.0x0.0.1",
# "127.0.0.0x1"), which glibc parses as 127.0.0.1 just the same. A real DNS
# hostname always has a letter-bearing label somewhere, so refusing this
# shape outright is safe.
_NUMERIC_LABEL_RE = re.compile(r"^(?:[0-9]+|0x[0-9a-f]+)$")
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
# Final review, Minor 5: these five IPv6 ranges are classified as private
# or reserved by Python 3.14's ipaddress tables, but NOT by every older
# interpreter, where some of them come back global. Pinning them here
# means this guard's policy does not move with the interpreter version.
# 2002::/16 (6to4) and 2001::/32 (Teredo) additionally EMBED an IPv4
# address, and 64:ff9b::/96 plus 64:ff9b:1::/48 (NAT64) translate one, so
# reaching them is a way to ask a gateway to reach the embedded IPv4:
# _is_blocked_ip checks that embedded address against the same deny list.
_BLOCKED_V6_NETWORKS = tuple(ipaddress.ip_network(n) for n in (
    "2002::/16",       # 6to4
    "2001::/32",       # Teredo
    "64:ff9b::/96",    # NAT64 well-known prefix
    "64:ff9b:1::/48",  # NAT64 local-use prefix
    "::/8",            # includes ::ffff:0:0/96 and the IPv4-compatible space
))
# Fix round 1, Critical 2: a control character (NUL, ESC, ...) or embedded
# whitespace ANYWHERE in the URL -- not just the host, which is all
# _HOSTNAME_CHARS_RE below covers -- used to sail straight through
# check_url's static gate and only blow up later, inside clip_fetch.fetch's
# httpx.URL(current) call (httpx.InvalidURL, uncaught by any handler there:
# a bare 500). Checked up front, before urlsplit ever runs, so a URL shaped
# like "http://example.com/a\x00b" is refused as bad_url at the cheapest
# possible point instead of reaching a redirect hop or a real socket.
_UNSAFE_URL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f\s]")


def _looks_like_numeric_ip_obfuscation(host: str) -> bool:
    labels = host.split(".")
    return all(_NUMERIC_LABEL_RE.match(label) for label in labels)


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


def _normalize_and_validate_host(host: str) -> str:
    """Lowercase `host` and reject it (as bad_url) if it is not a shape a
    real hostname or IP literal can take. Shared by check_url (the static
    URL gate) and resolve_and_check (the DNS-time gate) so neither can be
    handed a host shape the other would have rejected.

    A bracketed IPv6 literal ("[::1]", as _literal_ip also accepts, for a
    caller that passes one directly rather than through urlsplit, which
    strips the brackets itself) only needs its inner character set
    checked -- the dot-label rules below are for DNS names.

    Otherwise: strip exactly one trailing root-label dot ("example.com."
    is the same host as "example.com"), then reject any host that still
    has an empty label -- a leading dot, doubled dots anywhere, or a dot
    that survives that single strip (i.e. two or more trailing dots, like
    "localhost.."), all of which sail past a naive dot-strip-and-compare
    and would otherwise defeat the exact-hostname/suffix, IP-literal, and
    numeric-obfuscation checks below. Finally reject any character outside
    the hostname/IP-literal alphabet (a NUL byte, an embedded space, ...)."""
    host = host.lower()
    if host.startswith("[") and host.endswith("]"):
        inner = host[1:-1]
        if not inner or not _IPV6_LITERAL_CHARS_RE.match(inner):
            raise BlockedUrl("bad_url", f"host {host!r} contains characters outside the hostname alphabet")
        return host
    if host.endswith("."):
        host = host[:-1]
    if not host:
        raise BlockedUrl("bad_url", "URL has no host")
    if any(label == "" for label in host.split(".")):
        raise BlockedUrl("bad_url", f"host {host!r} has an empty label (a leading, doubled, or trailing dot)")
    if not _host_has_valid_charset(host):
        raise BlockedUrl("bad_url", f"host {host!r} contains characters outside the hostname alphabet")
    return host


def _reject_if_blocked_hostname(host: str) -> None:
    """Raise BlockedUrl(reason='blocked_host') for the static hostname
    denylist (an exact "localhost" match or a `.local`/`.internal`/`.lan`
    suffix). Shared by check_url and resolve_and_check so a hostname
    check_url would refuse is refused the same way if resolve_and_check
    is ever called with it directly (before any DNS lookup happens)."""
    if host in _BLOCKED_HOSTNAMES or host.endswith(_BLOCKED_SUFFIXES):
        raise BlockedUrl("blocked_host", f"{host} is not a fetchable host")


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
    address is technically IPv6). Also true for the explicitly pinned
    6to4/Teredo/NAT64/::/8 networks (_BLOCKED_V6_NETWORKS) and for a 6to4
    or Teredo address whose EMBEDDED IPv4 is itself blocked."""
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    if isinstance(ip, ipaddress.IPv4Address) and ip in _SHARED_ADDRESS_SPACE:
        return True
    if isinstance(ip, ipaddress.IPv6Address):
        if any(ip in net for net in _BLOCKED_V6_NETWORKS):
            return True
        # 6to4/Teredo carry an IPv4 address inside them; a public-looking
        # v6 wrapper must not launder a loopback or RFC1918 v4 target.
        embedded = [ip.sixtofour]
        if ip.teredo is not None:
            embedded.extend(ip.teredo)
        if any(e is not None and _is_blocked_ip(e) for e in embedded):
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
    reason='bad_url') for a control character or embedded whitespace
    ANYWHERE in the URL (not just the host -- httpx.URL raises its own
    uncaught InvalidURL on a NUL/control byte in the path, so this is
    checked before urlsplit ever runs), a non-http(s) scheme, embedded
    credentials, an unparseable/hostless URL, an out-of-range or
    non-numeric port, or a host containing a
    character outside the hostname alphabet; BlockedUrl(reason='blocked_host')
    for localhost, a `.local`/`.internal`/`.lan` suffix, or an IP-literal
    host in a blocked range. The root-label dot ("example.com." is the same host as
    "example.com") is stripped before every one of those checks runs, not
    just before the range check, since it defeats an exact-match hostname
    comparison ("localhost." != "localhost") just as easily as it defeats
    the numeric-obfuscation and IP-literal checks; a host with an empty
    label anywhere (a leading dot, doubled dots, or two-or-more trailing
    dots that a single-dot strip doesn't fully clear) is rejected outright
    for the same reason -- see _normalize_and_validate_host."""
    if not isinstance(url, str) or not url.strip():
        raise BlockedUrl("bad_url", "empty URL")
    raw = url.strip()
    if _UNSAFE_URL_CHARS_RE.search(raw):
        raise BlockedUrl("bad_url", "URL contains a control character or embedded whitespace")
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
    host = _normalize_and_validate_host(host)
    _reject_if_blocked_hostname(host)
    literal = _literal_ip(host)
    if literal is not None:
        if _is_blocked_ip(literal):
            raise BlockedUrl("blocked_host", f"{host} resolves to a blocked address range")
    elif _looks_like_numeric_ip_obfuscation(host):
        # Not parseable by ipaddress (see _NUMERIC_LABEL_RE's comment above)
        # but still numeric-shaped: reject before it ever reaches DNS.
        raise BlockedUrl("bad_url", f"{host} looks like a numeric IP address in disguise, not a real hostname")
    netloc = f"[{host}]" if literal is not None and literal.version == 6 else host
    try:
        port = parts.port
    except ValueError as exc:
        # urllib.parse validates the port LAZILY, on attribute access, so
        # ":65536", ":abc" and ":-1" raise here rather than at urlsplit.
        # Uncaught, that was a bare 500 out of the route (final review,
        # Critical 2); it is a malformed URL like any other.
        raise BlockedUrl("bad_url", "invalid port") from exc
    if port is not None:
        default_port = 80 if scheme == "http" else 443
        if port != default_port:
            netloc += f":{port}"
    return urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))


def resolve_and_check(host: str, *, resolver=None) -> list[str]:
    """Resolve `host` (an IP-literal host skips DNS entirely) and require
    EVERY returned address to pass the same range check check_url applies
    to a literal-IP host. This is the anti-DNS-rebinding gate: a hostname
    can pass check_url's static text check and still resolve to 127.0.0.1
    by the time the request actually fires. `resolver` defaults to
    socket.getaddrinfo(host, None); tests inject a fake with signature
    resolver(host, port) -> list of getaddrinfo-shaped tuples, so no real
    DNS lookup happens under test. Raises BlockedUrl(reason='bad_url') if
    `host` itself is not a shape check_url's static gate would have
    accepted (an empty label, a bad character, ...) or (reason=
    'blocked_host') if it is check_url's static hostname/suffix denylist
    or a blocked IP-literal/resolved-address range, or (reason=
    'dns_failed') if resolution itself raises -- any Exception, not just
    the OSError a real socket.getaddrinfo raises, since an injected/custom
    resolver can fail in other ways and this must fail closed regardless.
    All of this runs, and can reject, before the resolver is ever called:
    resolve_and_check must never be handed a host check_url would have
    refused and have that host reach DNS or the network."""
    getaddrinfo = resolver or socket.getaddrinfo
    host = _normalize_and_validate_host(host)
    _reject_if_blocked_hostname(host)
    literal = _literal_ip(host)
    if literal is not None:
        # Final review, Important 1: this used to return the literal
        # unchecked, contradicting the docstring above and leaving the deny
        # list with a single enforcement point (check_url) rather than the
        # two the design claims. Any future caller that trusts the
        # documented contract is now actually covered.
        if _is_blocked_ip(literal):
            raise BlockedUrl("blocked_host", f"{host} is in a blocked address range")
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
